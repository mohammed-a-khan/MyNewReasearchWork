/**
 * Re-rate a slice of the live portfolio through the broker API and compare every premium with the
 * underwriting manual (lib/larkspur.ts). Logic that is easier in code: loops over query rows, a switch
 * on the product, derived risk factors (driver age from a date of birth), soft checks that collect
 * every mismatch, and a CSV report for the pricing team.
 */
import { journey, run, step } from '@mohammed-a-khan/eztest/sdk';
import { expectedPremium, type Product, type Region } from '../../lib/larkspur.ts';

interface PolicyRow {
  policy_id: string;
  product: Product;
  sum_insured: number;
  region: Region;
  date_of_birth: string | null;
}

interface QuoteBody {
  quoteId: string;
  premium: { netPremium: number; tax: number; totalPremium: number; loadingPct: number };
}

const ageOn = (dob: string, on: Date): number => {
  const d = new Date(`${dob}T00:00:00Z`);
  let age = on.getUTCFullYear() - d.getUTCFullYear();
  if (on.getUTCMonth() < d.getUTCMonth() || (on.getUTCMonth() === d.getUTCMonth() && on.getUTCDate() < d.getUTCDate())) age--;
  return age;
};

for (const region of ['COAST', 'METRO'] as const) {
  journey(
    `Portfolio re-rating for ${region} matches the underwriting manual`,
    { id: `portfolio-rating-${region.toLowerCase()}`, tags: ['@code', '@rating', '@api', '@regression'], requirements: ['RATE-1', 'RATE-6'], risk: 4 },
    async ({ api, db, vars, expect, soft, files, log }) => {
      const rows = await step(`Read active ${region} policies`, () => db.query<PolicyRow>('ACTIVE_POLICIES_BY_REGION', { region, per_product: 4 }));
      await expect(rows.length, 'policies to re-rate').toBeGreaterThan(0);

      const report: Array<Record<string, unknown>> = [];
      const today = new Date();
      for (const p of rows) {
        await step(`Re-rate ${p.policy_id} (${p.product})`, async () => {
          // Risk age: the property's age is not on file for home policies, so the manual's default applies.
          let riskAge: number;
          switch (p.product) {
            case 'HOME':
              riskAge = 20;
              break;
            case 'MOTOR':
              riskAge = p.date_of_birth ? ageOn(p.date_of_birth, today) : 40;
              break;
            default:
              throw new Error(`unknown product ${String(p.product)}`);
          }
          const input = { product: p.product, sumInsured: p.sum_insured, region: p.region, riskAge, noClaimsYears: 2 };
          const want = expectedPremium(input);
          // The .ez library journey and this TypeScript helper implement the same manual: they must agree.
          const ez = await run('expected-premium', { ...input, sumInsured: String(input.sumInsured), riskAge: String(riskAge), noClaimsYears: '2' });
          await expect(Number(ez.total), `${p.policy_id} .ez rules vs TypeScript rules`).toBe(want.totalPremium);
          const res = await api.post<QuoteBody>(`${vars.config('API_URL')}/v1/quotes`, input, { asRole: 'broker', expectStatus: 201 });
          const got = res.body.premium;
          await soft(async () => {
            await expect(got.totalPremium, `${p.policy_id} total`).toBeCloseTo(want.totalPremium, 2);
            await expect(got.tax, `${p.policy_id} tax`).toBeCloseTo(want.tax, 2);
            await expect(got.loadingPct, `${p.policy_id} loading`).toBe(want.loadingPct);
          });
          report.push({ policy: p.policy_id, product: p.product, riskAge, expected: want.totalPremium.toFixed(2), rated: got.totalPremium.toFixed(2), quote: res.body.quoteId, ok: got.totalPremium === want.totalPremium });
        });
      }
      const out = await files.writeCsv(`eztest-results/portfolio-rating-${region.toLowerCase()}.csv`, report);
      log.info(`re-rated ${report.length} ${region} policies, report ${out}`);
      await expect(report.filter((r) => !r.ok).length, 'premium mismatches').toBe(0);
    },
  );
}
