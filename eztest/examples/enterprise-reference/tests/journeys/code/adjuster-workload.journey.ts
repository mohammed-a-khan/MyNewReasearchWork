/**
 * An adjuster works through a small queue: page objects (screens/claimdesk.ts), a switch on the
 * claim type, try/catch around a refusal the system must give, a retry-until on the queue, and the
 * database as the referee. Seeding reuses the .ez suite's code steps; cleanup runs in finally.
 */
import { journey, step } from 'eztest/sdk';
import { decisionLevel, expectedPayout, money } from '../../lib/larkspur.ts';
import { ClaimDesk } from '../../screens/claimdesk.ts';
import { removeClaim, seedClaim } from '../../steps/claims.steps.ts';

interface Seeded {
  claimId: string;
}

const WORK = [
  { policyId: 'POL-M-200455', type: 'GLASS', amount: 480 },
  { policyId: 'POL-H-100231', type: 'THEFT', amount: 2300 },
  { policyId: 'POL-H-100231', type: 'FIRE', amount: 14250 },
] as const;

journey(
  'Adjuster clears a mixed queue with the right decision for each claim',
  { id: 'adjuster-workload', role: 'adjuster', tags: ['@code', '@backoffice', '@regression'], requirements: ['ADJ-1', 'ADJ-2', 'ADJ-5'], risk: 4 },
  async (ctx) => {
    const { ui, db, vars, expect, log } = ctx;
    const backoffice = vars.config('BACKOFFICE_URL');
    const claims = db.on('claims');
    const seeded: Array<{ claimId: string; type: string; amount: number; policyId: string }> = [];
    try {
      for (const w of WORK) {
        const s = (await seedClaim(ctx, { policyId: w.policyId, type: w.type, amount: String(w.amount) })) as Seeded;
        seeded.push({ ...w, claimId: s.claimId });
      }
      await ui.login();

      // The queue is eventually consistent with the API: retry the search until all three are listed.
      await step('All seeded claims are in the queue', async () => {
        for (const c of seeded) {
          await ui.open(`${backoffice}/queue?q=${c.claimId}`);
          await ui.click(ClaimDesk.searchButton, { expect: `the "Claims queue" table contains "${c.claimId}"`, poll: { attempts: 5, intervalMs: 500 } });
        }
      });

      for (const c of seeded) {
        await step(`Decide ${c.claimId} (${c.type}, ${money(c.amount)})`, async () => {
          await ui.open(`${backoffice}/claims/${c.claimId}`);
          await expect.ui.page().toContainText(`Review claim ${c.claimId}`);
          switch (c.type) {
            case 'GLASS': {
              await ui.select(ClaimDesk.reason, 'Covered in full');
              await ui.click(ClaimDesk.approve, { expect: { text: `Claim ${c.claimId} approved` } });
              const [{ deductible }] = await claims.sql<{ deductible: number }>`SELECT deductible FROM policies WHERE id = ${c.policyId}`;
              await expect.ui.text(ClaimDesk.payout).toBe(money(expectedPayout(c.amount, deductible)));
              break;
            }
            case 'THEFT': {
              await ui.select(ClaimDesk.reason, 'Insufficient evidence');
              await ui.acceptNextDialog();
              await ui.click(ClaimDesk.reject, { expect: { text: `Claim ${c.claimId} rejected` } });
              break;
            }
            default: {
              // Above the adjuster's limit: approving must be refused; the adjuster then refers it.
              await expect(decisionLevel(c.amount)).toBe('SENIOR');
              await ui.select(ClaimDesk.reason, 'Covered in full');
              try {
                await ui.click(ClaimDesk.approve, { expect: { text: `Claim ${c.claimId} approved` }, timeoutMs: 3000 });
                throw new Error(`an adjuster could approve ${c.claimId} above the limit`);
              } catch (e) {
                if ((e as Error).message.startsWith('an adjuster could approve')) throw e;
                log.info(`approval refused as expected: ${(e as Error).message.split('\n')[0]}`);
              }
              await expect.ui.page().toContainText('exceeds your limit');
              await ui.select(ClaimDesk.reason, 'Over my authority');
              await ui.click(ClaimDesk.refer, { expect: { text: 'referred to a senior adjuster' } });
            }
          }
        });
      }

      const final = await claims.sql<{ id: string; status: string }>`SELECT id, status FROM claims WHERE id IN (${seeded[0].claimId}, ${seeded[1].claimId}, ${seeded[2].claimId}) ORDER BY id`;
      await expect.rows(final).toEqual(
        [
          { id: seeded[0].claimId, status: 'APPROVED' },
          { id: seeded[1].claimId, status: 'REJECTED' },
          { id: seeded[2].claimId, status: 'REFERRED' },
        ],
        { key: 'id' },
      );
    } finally {
      for (const c of seeded) await removeClaim(ctx, { claimId: c.claimId });
    }
  },
);
