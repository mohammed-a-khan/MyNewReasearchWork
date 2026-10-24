/**
 * The nightly settlement batch: every claim whose settlement was accepted is
 * paid, a payment file is dropped for the bank (CSV, written atomically), and
 * the run's control totals are kept in batch_runs.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextId, type Row } from './db.ts';
import { HttpError, round2 } from './http.ts';
import type { Services } from './services.ts';
import { settings } from './settings.ts';

export const BATCH_JOB = 'nightly-settlement';

const maskIban = (iban: string) => `${iban.slice(0, 4)}${'*'.repeat(Math.max(0, iban.length - 8))}${iban.slice(-4)}`;
const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function outboundDir(): string {
  return join(settings.dropDir, 'outbound');
}

export function startBatch(svc: Services, businessDate: string): Row {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new HttpError(422, 'businessDate must be YYYY-MM-DD', 'validation_failed');
  const running = svc.db.prepare("SELECT id FROM batch_runs WHERE job = ? AND status = 'RUNNING'").get(BATCH_JOB) as Row | undefined;
  if (running) throw new HttpError(409, `batch ${running.id} is still running`, 'batch_running');
  const id = `BATCH-${nextId(svc.db, 'batch', 7000)}`;
  svc.db.prepare("INSERT INTO batch_runs (id, job, business_date, status, started_at) VALUES (?, ?, ?, 'RUNNING', ?)").run(id, BATCH_JOB, businessDate, svc.now());
  setTimeout(() => {
    try {
      runBatch(svc, id, businessDate);
    } catch (e) {
      svc.db.prepare("UPDATE batch_runs SET status = 'FAILED', finished_at = ?, error = ? WHERE id = ?").run(svc.now(), (e as Error).message, id);
    }
  }, settings.batchDelayMs);
  return svc.db.prepare('SELECT * FROM batch_runs WHERE id = ?').get(id) as Row;
}

function runBatch(svc: Services, id: string, businessDate: string): void {
  const due = svc.db
    .prepare(
      `SELECT c.id, c.policy_id, c.customer_id, c.payout_amount, c.bank_iban, cu.full_name
         FROM claims c JOIN customers cu ON cu.id = c.customer_id
        WHERE c.status = 'SETTLEMENT_ACCEPTED' ORDER BY c.id`,
    )
    .all() as Row[];
  const lines = ['payment_id,claim_id,policy_id,customer_id,payee_name,iban_masked,amount,currency,business_date'];
  let total = 0;
  const paid: Array<{ claim: string; payment: string }> = [];
  svc.db.exec('BEGIN IMMEDIATE');
  try {
    for (const c of due) {
      const paymentId = `PAY-${nextId(svc.db, 'payment', 880000)}`;
      const amount = round2(Number(c.payout_amount));
      svc.db.prepare('INSERT INTO payments (id, claim_id, batch_id, amount, iban, business_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(paymentId, String(c.id), id, amount, String(c.bank_iban), businessDate, svc.now());
      lines.push([paymentId, c.id, c.policy_id, c.customer_id, c.full_name, maskIban(String(c.bank_iban)), amount.toFixed(2), 'GBP', businessDate].map(csvCell).join(','));
      total = round2(total + amount);
      paid.push({ claim: String(c.id), payment: paymentId });
    }
    const fileName = `SETTLEMENTS_${businessDate.replace(/-/g, '')}_${id}.csv`;
    mkdirSync(outboundDir(), { recursive: true });
    const tmp = join(outboundDir(), `.${fileName}.part`);
    writeFileSync(tmp, `${lines.join('\n')}\n`);
    renameSync(tmp, join(outboundDir(), fileName));
    svc.db.prepare("UPDATE batch_runs SET status = 'COMPLETED', finished_at = ?, file_name = ?, record_count = ?, total_amount = ? WHERE id = ?").run(svc.now(), fileName, paid.length, total, id);
    svc.db.exec('COMMIT');
  } catch (e) {
    svc.db.exec('ROLLBACK');
    throw e;
  }
  for (const p of paid) svc.markPaid(p.claim, p.payment, id);
  svc.log(`[batch] ${id} paid ${paid.length} settlement(s), total ${total.toFixed(2)}`);
}

export function batchRun(svc: Services, id: string): Row | undefined {
  return svc.db.prepare('SELECT * FROM batch_runs WHERE id = ?').get(id) as Row | undefined;
}
