/**
 * Claims domain services shared by the portal, the back office and the API:
 * quotes, first notice of loss, decisions, settlement, events (outbox +
 * Kafka) and notifications (SMTP).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { nextId, type Row } from './db.ts';
import { HttpError, round2 } from './http.ts';
import { KafkaProducer } from './kafka.ts';
import { ratePremium, validateQuote, type Premium, type QuoteInput } from './rating.ts';
import { ADJUSTER_LIMIT, settings, urls } from './settings.ts';
import { sendMail } from './smtp.ts';
import { oneTimeCode } from './totp.ts';

export const CLAIM_TYPES = { HOME: ['WATER', 'FIRE', 'THEFT', 'STORM', 'GLASS'], MOTOR: ['COLLISION', 'GLASS', 'THEFT'] } as const;
export const EVENTS_TOPIC = 'larkspur.claims.events';
export const LATE_NOTIFICATION_DAYS = 30;

export interface Upload {
  filename: string;
  contentType?: string;
  data: Buffer;
}

export class Services {
  readonly db: DatabaseSync;
  private producer?: KafkaProducer;
  private publishing: Promise<void> = Promise.resolve();
  readonly log: (msg: string) => void;

  constructor(db: DatabaseSync, log: (msg: string) => void = (m) => console.log(m)) {
    this.db = db;
    this.log = log;
    if (settings.kafka !== 'off') this.producer = new KafkaProducer(settings.kafka);
  }

  now(): string {
    return new Date().toISOString();
  }

  // ------------------------------------------------------------------ reads
  customer(id: string): Row | undefined {
    return this.db.prepare('SELECT id, full_name, email, phone, segment, region, date_of_birth FROM customers WHERE id = ?').get(id) as Row | undefined;
  }

  policies(customerId: string): Row[] {
    return this.db.prepare('SELECT * FROM policies WHERE customer_id = ? ORDER BY id').all(customerId) as Row[];
  }

  policy(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM policies WHERE id = ?').get(id) as Row | undefined;
  }

  claim(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM claims WHERE id = ?').get(id) as Row | undefined;
  }

  claimDocuments(id: string): Row[] {
    return this.db.prepare('SELECT filename, content_type, size, sha256, uploaded_at FROM claim_documents WHERE claim_id = ? ORDER BY id').all(id) as Row[];
  }

  claimsOf(customerId: string, status?: string): Row[] {
    return (status
      ? this.db.prepare('SELECT * FROM claims WHERE customer_id = ? AND status = ? ORDER BY reported_at DESC, id DESC').all(customerId, status)
      : this.db.prepare('SELECT * FROM claims WHERE customer_id = ? ORDER BY reported_at DESC, id DESC').all(customerId)) as Row[];
  }

  // ------------------------------------------------------------------ quotes
  quote(raw: Record<string, unknown>, channel: string, customerId?: string): { id: string; input: QuoteInput; premium: Premium } {
    const input = validateQuote(raw);
    const premium = ratePremium(input);
    const id = `Q-${nextId(this.db, 'quote', 500000)}`;
    this.db
      .prepare(
        `INSERT INTO quotes (id, customer_id, channel, product, sum_insured, region, risk_age, no_claims_years, base_premium, loaded_premium, discount, net_premium, tax, total_premium, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, customerId ?? null, channel, input.product, input.sumInsured, input.region, input.riskAge, input.noClaimsYears, premium.basePremium, premium.loadedPremium, premium.discount, premium.netPremium, premium.tax, premium.totalPremium, this.now());
    return { id, input, premium };
  }

  quoteById(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM quotes WHERE id = ?').get(id) as Row | undefined;
  }

  // ------------------------------------------------------------------ first notice of loss
  createClaim(
    input: { policyId: string; customerId?: string; type: string; incidentDate: string; amountClaimed: number; description: string; externalRef?: string },
    channel: 'PORTAL' | 'BROKER' | 'PHONE',
    uploads: Upload[] = [],
  ): Row {
    const policy = this.policy(input.policyId);
    const problems: string[] = [];
    if (!policy) throw new HttpError(404, `policy ${input.policyId} not found`, 'policy_not_found');
    if (input.customerId && policy.customer_id !== input.customerId) throw new HttpError(403, 'policy does not belong to this customer', 'forbidden');
    if (policy.status !== 'ACTIVE') throw new HttpError(409, `policy ${policy.id} is ${String(policy.status).toLowerCase()}; claims can only be filed on active policies`, 'policy_not_active');
    const types = CLAIM_TYPES[policy.product as 'HOME' | 'MOTOR'] as readonly string[];
    if (!types.includes(input.type)) problems.push(`type must be one of ${types.join(', ')}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.incidentDate)) problems.push('incidentDate must be YYYY-MM-DD');
    else if (input.incidentDate < String(policy.start_date) || input.incidentDate > String(policy.end_date)) problems.push('incidentDate is outside the policy period');
    if (!Number.isFinite(input.amountClaimed) || input.amountClaimed <= 0) problems.push('amountClaimed must be positive');
    if (input.amountClaimed > Number(policy.sum_insured)) problems.push('amountClaimed exceeds the sum insured');
    if (!input.description || input.description.trim().length < 10) problems.push('description must be at least 10 characters');
    if (problems.length) throw new HttpError(422, problems.join('; '), 'validation_failed');
    if (input.externalRef) {
      const dup = this.db.prepare('SELECT id FROM claims WHERE external_ref = ?').get(input.externalRef) as Row | undefined;
      if (dup) throw new HttpError(409, `a claim with externalRef ${input.externalRef} already exists (${dup.id})`, 'duplicate');
    }
    const id = `CLM-${nextId(this.db, 'claim', 300000)}`;
    const reportedAt = this.now();
    const daysLate = Math.floor((Date.parse(reportedAt.slice(0, 10)) - Date.parse(input.incidentDate)) / 86_400_000);
    const late = daysLate > LATE_NOTIFICATION_DAYS ? 1 : 0;
    const priority = input.amountClaimed > ADJUSTER_LIMIT ? 'HIGH' : 'NORMAL';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO claims (id, policy_id, customer_id, type, channel, incident_date, reported_at, description, amount_claimed, status, priority, late_notification, external_ref, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', ?, ?, ?, ?)`,
        )
        .run(id, policy.id as string, policy.customer_id as string, input.type, channel, input.incidentDate, reportedAt, input.description.trim(), round2(input.amountClaimed), priority, late, input.externalRef ?? null, reportedAt);
      for (const u of uploads) {
        this.db
          .prepare('INSERT INTO claim_documents (claim_id, filename, content_type, size, sha256, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, u.filename, u.contentType ?? 'application/octet-stream', u.data.length, createHash('sha256').update(u.data).digest('hex'), reportedAt);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    const claim = this.claim(id)!;
    this.emit(claim, 'claim.submitted', { amountClaimed: claim.amount_claimed, channel, documents: uploads.length, lateNotification: late === 1 });
    const cust = this.customer(String(claim.customer_id))!;
    this.notify(id, String(cust.email), `Claim ${id} received`, `Dear ${cust.full_name},\n\nWe have received your ${String(claim.type).toLowerCase()} claim ${id} for ${Number(claim.amount_claimed).toFixed(2)} GBP on policy ${claim.policy_id}.\nA claims adjuster will review it shortly.\n\nLarkspur Mutual`);
    return claim;
  }

  // ------------------------------------------------------------------ decisions
  assign(claimId: string, staff: string): void {
    const c = this.mustClaim(claimId);
    if (c.status === 'SUBMITTED') {
      this.db.prepare("UPDATE claims SET status = 'IN_REVIEW', assigned_to = ?, updated_at = ? WHERE id = ?").run(staff, this.now(), claimId);
      this.emit(this.mustClaim(claimId), 'claim.in_review', { assignedTo: staff });
    }
  }

  decide(claimId: string, staff: Row, decision: 'APPROVE' | 'REJECT' | 'REFER', opts: { approvedAmount?: number; reason: string }): Row {
    const c = this.mustClaim(claimId);
    if (!['SUBMITTED', 'IN_REVIEW', 'REFERRED'].includes(String(c.status))) throw new HttpError(409, `claim ${claimId} is already ${String(c.status).toLowerCase()}`, 'already_decided');
    if (c.status === 'REFERRED' && staff.role !== 'SENIOR') throw new HttpError(403, `claim ${claimId} is referred to a senior adjuster`, 'referred');
    if (!opts.reason) throw new HttpError(422, 'a decision reason is required', 'validation_failed');
    const at = this.now();
    if (decision === 'REFER') {
      this.db.prepare("UPDATE claims SET status = 'REFERRED', referred_to = 'SENIOR', decision_reason = ?, updated_at = ? WHERE id = ?").run(opts.reason, at, claimId);
      const r = this.mustClaim(claimId);
      this.emit(r, 'claim.referred', { referredBy: staff.username, reason: opts.reason });
      return r;
    }
    if (decision === 'REJECT') {
      this.db.prepare("UPDATE claims SET status = 'REJECTED', decision_by = ?, decision_at = ?, decision_reason = ?, updated_at = ? WHERE id = ?").run(String(staff.username), at, opts.reason, at, claimId);
      const r = this.mustClaim(claimId);
      this.emit(r, 'claim.rejected', { decisionBy: staff.username, reason: opts.reason });
      const cust = this.customer(String(r.customer_id))!;
      this.notify(claimId, String(cust.email), `Claim ${claimId} decision`, `Dear ${cust.full_name},\n\nWe are sorry: your claim ${claimId} was not accepted (${opts.reason.replace(/_/g, ' ').toLowerCase()}).\n\nLarkspur Mutual`);
      return r;
    }
    const amount = round2(Number(opts.approvedAmount));
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(422, 'approved amount must be positive', 'validation_failed');
    if (amount > Number(c.amount_claimed)) throw new HttpError(422, 'approved amount cannot exceed the amount claimed', 'validation_failed');
    if (amount > Number(staff.approval_limit)) throw new HttpError(403, `approval of ${amount.toFixed(2)} exceeds your limit of ${Number(staff.approval_limit).toFixed(2)}; refer it to a senior adjuster`, 'over_limit');
    const policy = this.policy(String(c.policy_id))!;
    const deductible = settings.bug === 'payout-deductible' ? 0 : Number(policy.deductible);
    const payout = Math.max(0, round2(amount - deductible));
    const code = oneTimeCode();
    const token = randomBytes(18).toString('base64url');
    this.db
      .prepare("UPDATE claims SET status = 'APPROVED', decision_by = ?, decision_at = ?, decision_reason = ?, approved_amount = ?, payout_amount = ?, settlement_code = ?, settlement_token = ?, updated_at = ? WHERE id = ?")
      .run(String(staff.username), at, opts.reason, amount, payout, code, token, at, claimId);
    const r = this.mustClaim(claimId);
    this.emit(r, 'claim.approved', { decisionBy: staff.username, approvedAmount: amount, deductible: Number(policy.deductible), payoutAmount: payout, currency: 'GBP' });
    const cust = this.customer(String(r.customer_id))!;
    const link = `${urls.portal()}/app/settlement/${claimId}?token=${token}`;
    this.notify(
      claimId,
      String(cust.email),
      `Claim ${claimId} approved - confirm your settlement`,
      `Dear ${cust.full_name},\n\nGood news: your claim ${claimId} has been approved.\nApproved amount: ${amount.toFixed(2)} GBP\nPolicy excess: ${Number(policy.deductible).toFixed(2)} GBP\nWe will pay: ${payout.toFixed(2)} GBP\n\nConfirm your bank details here: ${link}\nYour confirmation code is ${code}. It is valid for 7 days.\n\nLarkspur Mutual`,
      `<p>Dear ${cust.full_name},</p><p>Good news: your claim <b>${claimId}</b> has been approved.</p><p>We will pay <b>${payout.toFixed(2)} GBP</b>.</p><p><a href="${link}">Confirm your settlement</a></p><p>Your confirmation code is <b>${code}</b>.</p>`,
    );
    return r;
  }

  acceptSettlement(claimId: string, customerId: string, token: string, code: string, iban: string): Row {
    const c = this.mustClaim(claimId);
    if (c.customer_id !== customerId) throw new HttpError(403, 'not your claim', 'forbidden');
    if (c.status !== 'APPROVED') throw new HttpError(409, `claim ${claimId} is ${String(c.status).toLowerCase()}, not awaiting settlement`, 'not_approved');
    if (!token || token !== c.settlement_token) throw new HttpError(403, 'this settlement link is not valid', 'bad_token');
    if (code.trim() !== c.settlement_code) throw new HttpError(422, 'the confirmation code is not correct', 'bad_code');
    const cleanIban = iban.replace(/\s+/g, '').toUpperCase();
    if (!/^GB\d{2}[A-Z]{4}\d{14}$/.test(cleanIban)) throw new HttpError(422, 'enter a UK IBAN (GB, 22 characters)', 'bad_iban');
    const at = this.now();
    this.db.prepare("UPDATE claims SET status = 'SETTLEMENT_ACCEPTED', settlement_accepted_at = ?, bank_iban = ?, updated_at = ? WHERE id = ?").run(at, cleanIban, at, claimId);
    const r = this.mustClaim(claimId);
    this.emit(r, 'settlement.accepted', { payoutAmount: r.payout_amount, ibanLast4: cleanIban.slice(-4) });
    return r;
  }

  markPaid(claimId: string, paymentId: string, batchId: string): void {
    this.db.prepare("UPDATE claims SET status = 'SETTLED', updated_at = ? WHERE id = ?").run(this.now(), claimId);
    this.emit(this.mustClaim(claimId), 'claim.paid', { paymentId, batchId });
  }

  private mustClaim(id: string): Row {
    const c = this.claim(id);
    if (!c) throw new HttpError(404, `claim ${id} not found`, 'claim_not_found');
    return c;
  }

  // ------------------------------------------------------------------ events and notifications
  emit(claim: Row, type: string, extra: Record<string, unknown>): void {
    const event = {
      eventId: randomUUID(),
      type,
      occurredAt: this.now(),
      claimId: claim.id,
      policyId: claim.policy_id,
      customerId: claim.customer_id,
      status: claim.status,
      ...extra,
    };
    const row = this.db.prepare('INSERT INTO claim_events (event_id, claim_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)').run(event.eventId, String(claim.id), type, JSON.stringify(event), event.occurredAt);
    const outboxId = Number(row.lastInsertRowid);
    // Publish in order, after the transaction, without blocking the request.
    this.publishing = this.publishing.then(async () => {
      if (!this.producer) return;
      try {
        await this.producer.send(EVENTS_TOPIC, [{ key: String(claim.id), value: JSON.stringify(event), headers: { 'event-type': type, source: 'larkspur-claims', 'content-type': 'application/json' } }]);
        this.db.prepare('UPDATE claim_events SET published = 1 WHERE id = ?').run(outboxId);
      } catch (e) {
        this.log(`[events] could not publish ${type} for ${claim.id}: ${(e as Error).message}`);
      }
    });
  }

  notify(claimId: string | null, to: string, subject: string, text: string, html?: string): void {
    const row = this.db.prepare("INSERT INTO notifications (claim_id, channel, recipient, subject, status, created_at) VALUES (?, 'EMAIL', ?, ?, 'PENDING', ?)").run(claimId, to, subject, this.now());
    const id = Number(row.lastInsertRowid);
    if (settings.smtp === 'off') return;
    void sendMail(settings.smtp, { from: 'claims@larkspur.test', to, subject, text, html })
      .then(() => this.db.prepare("UPDATE notifications SET status = 'SENT' WHERE id = ?").run(id))
      .catch((e: Error) => {
        this.db.prepare("UPDATE notifications SET status = 'FAILED' WHERE id = ?").run(id);
        this.log(`[mail] could not send "${subject}" to ${to}: ${e.message}`);
      });
  }

  async close(): Promise<void> {
    await this.publishing;
    this.producer?.close();
  }
}
