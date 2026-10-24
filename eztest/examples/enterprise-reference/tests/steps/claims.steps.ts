/**
 * Code steps the .ez journeys call with `Run code "steps/claims.steps.ts#<name>" with ... as <result>`.
 * Preconditions are seeded the way a team would: through the partner API where one exists, and
 * straight into the database for states the API cannot reach (an approved or accepted settlement).
 * Every seeded claim can be removed again with removeClaim (afterEach-style cleanup).
 */
import { codeStep } from 'eztest/sdk';
import { expectedPayout, isoDaysFrom, testRef } from '../lib/larkspur.ts';

interface ClaimBody {
  claimId: string;
  amountClaimed: number;
  status: string;
}

/** File a claim through the broker API (channel BROKER) and return its id. */
export const seedClaim = codeStep<{ policyId: string; type: string; amount: string; daysAgo?: string; description?: string }>(async ({ api, vars, log }, p) => {
  const externalRef = testRef('BRK');
  const res = await api.post<ClaimBody>(
    `${vars.config('API_URL')}/v1/claims`,
    {
      policyId: p.policyId,
      type: p.type,
      incidentDate: isoDaysFrom(new Date(), -Number(p.daysAgo ?? 3)),
      amountClaimed: Number(p.amount),
      description: p.description ?? `Seeded by the regression suite (${externalRef})`,
      externalRef,
    },
    { asRole: 'broker', expectStatus: 201, intent: `Seed a ${p.type} claim of ${p.amount} on ${p.policyId}` },
  );
  log.info(`seeded claim ${res.body.claimId} (${externalRef})`);
  return { claimId: res.body.claimId, externalRef, amount: res.body.amountClaimed };
});

/**
 * A claim that is already approved, with a known settlement code and link token, seeded through the
 * API (FNOL) and then the database (the decision). For journeys that start after the back office.
 */
export const seedApprovedClaim = codeStep<{ policyId: string; type: string; amount: string; approved: string; accepted?: string }>(async (ctx, p) => {
  const { db } = ctx;
  const seeded = (await seedClaim(ctx, { policyId: p.policyId, type: p.type, amount: p.amount })) as { claimId: string };
  const claims = db.on('claims');
  const [{ deductible }] = await claims.sql<{ deductible: number }>`SELECT deductible FROM policies WHERE id = ${p.policyId}`;
  const approved = Number(p.approved);
  const payout = expectedPayout(approved, deductible);
  const code = String(100000 + Math.floor(Math.random() * 899999));
  const token = testRef('TOK').replace(/[^A-Z0-9]/g, '');
  const now = new Date().toISOString();
  const accepted = p.accepted === 'yes';
  await claims.sql`UPDATE claims
      SET status = ${accepted ? 'SETTLEMENT_ACCEPTED' : 'APPROVED'}, decision_by = 'dana.okafor', decision_at = ${now}, decision_reason = 'COVERED',
          approved_amount = ${approved}, payout_amount = ${payout}, settlement_code = ${code}, settlement_token = ${token},
          settlement_accepted_at = ${accepted ? now : null}, bank_iban = ${accepted ? 'GB33LKSP40470100012345' : null}, updated_at = ${now}
    WHERE id = ${seeded.claimId}`;
  return { claimId: seeded.claimId, payout, code, token, deductible };
});

/** Remove a claim the suite created, with everything that hangs off it. */
export const removeClaim = codeStep<{ claimId: string }>(async ({ db, log }, p) => {
  if (!/^CLM-3\d{5}$/.test(p.claimId)) throw new Error(`removeClaim only removes claims the suite created (CLM-3xxxxx), not ${p.claimId}`);
  const claims = db.on('claims');
  await claims.sql`DELETE FROM claim_documents WHERE claim_id = ${p.claimId}`;
  await claims.sql`DELETE FROM claim_events WHERE claim_id = ${p.claimId}`;
  await claims.sql`DELETE FROM notifications WHERE claim_id = ${p.claimId}`;
  await claims.sql`DELETE FROM payments WHERE claim_id = ${p.claimId}`;
  await claims.sql`DELETE FROM claims WHERE id = ${p.claimId}`;
  log.info(`removed claim ${p.claimId}`);
  return { removed: p.claimId };
});
