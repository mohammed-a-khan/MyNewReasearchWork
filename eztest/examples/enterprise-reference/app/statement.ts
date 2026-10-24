/** The claim settlement statement (PDF), generated from the database. */
import type { Row } from './db.ts';
import { HttpError, money } from './http.ts';
import { buildPdf, type TextRun } from './pdf.ts';
import type { Services } from './services.ts';

export function statementPdf(svc: Services, claimId: string): Buffer {
  const c = svc.claim(claimId);
  if (!c) throw new HttpError(404, `claim ${claimId} not found`);
  if (!['APPROVED', 'SETTLEMENT_ACCEPTED', 'SETTLED'].includes(String(c.status))) throw new HttpError(409, `no statement for a ${String(c.status).toLowerCase()} claim`);
  const policy = svc.policy(String(c.policy_id))!;
  const cust = svc.customer(String(c.customer_id))!;
  const payment = svc.db.prepare('SELECT * FROM payments WHERE claim_id = ?').get(claimId) as Row | undefined;
  const runs: TextRun[] = [];
  let y = 790;
  const t = (x: number, text: string, o: Partial<TextRun> = {}) => runs.push({ x, y, text, ...o });
  t(50, 'Larkspur Mutual - Claim Settlement Statement', { size: 16, bold: true });
  y -= 34;
  const field = (label: string, value: string) => {
    t(50, label);
    t(200, value);
    y -= 18;
  };
  field('Statement No:', `ST-${claimId.slice(4)}`);
  field('Claim reference:', claimId);
  field('Policy number:', String(policy.id));
  field('Policyholder:', String(cust.full_name));
  field('Claim type:', String(c.type));
  field('Incident date:', String(c.incident_date));
  field('Amount claimed:', money(Number(c.amount_claimed)));
  field('Status:', String(c.status));
  field('Payment reference:', payment ? String(payment.id) : 'PENDING');
  y -= 14;
  t(50, 'Item', { bold: true });
  t(400, 'Amount', { bold: true });
  y -= 18;
  const deductible = Number(policy.deductible);
  const lines: Array<[string, number]> = [
    ['Assessed loss', Number(c.approved_amount)],
    ['Less policy excess', -deductible],
  ];
  for (const [label, amount] of lines) {
    t(50, label);
    t(400, money(amount));
    y -= 16;
  }
  y -= 10;
  t(50, 'Settlement amount:', { bold: true });
  t(400, money(Number(c.payout_amount)), { bold: true });
  y -= 30;
  t(50, 'Amounts in GBP. This statement was produced by the Larkspur statement service.', { size: 8 });
  return buildPdf([runs], { title: `Settlement statement ${claimId}`, author: 'Larkspur Mutual', subject: claimId });
}
