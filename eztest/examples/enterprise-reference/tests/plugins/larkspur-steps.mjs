/**
 * Larkspur team plugin: business phrasings the whole suite shares.
 *
 *   Generate a UK IBAN as iban                      a valid (mod-97) GB IBAN, unique per run and worker
 *   Read the premium breakdown into premium         the MyCover "Premium breakdown" table as numbers
 *
 * A project that installs @mohammed-a-khan/eztest from npm would write `import { definePlugin } from '@mohammed-a-khan/eztest/plugins'`;
 * definePlugin only adds typing, so this in-repo example exports the plain object.
 */
import { randomInt } from 'node:crypto';

let counter = 0;

/** ISO 13616 check digits: move the country code and "00" to the end, letters to numbers, mod 97. */
function checkDigits(country, bban) {
  const digits = `${bban}${country}00`.toUpperCase().replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  return String(98 - rem).padStart(2, '0');
}

export function ukIban() {
  // Sort code 40-47-xx is reserved here for test accounts; the account number carries a per-process counter.
  const sort = `4047${String(randomInt(0, 100)).padStart(2, '0')}`;
  const account = `${String(process.pid % 1000).padStart(3, '0')}${String(++counter % 100000).padStart(5, '0')}`;
  const bban = `LKSP${sort}${account}`;
  return `GB${checkDigits('GB', bban)}${bban}`;
}

const LABELS = {
  'Base premium': 'basePremium',
  'Region factor': 'regionFactor',
  'Risk loading': 'loadingPct',
  'Loaded premium': 'loadedPremium',
  'No-claims discount': 'noClaimsDiscountPct',
  Discount: 'discount',
  'Net premium': 'netPremium',
  'Insurance premium tax (12%)': 'tax',
  'Total annual premium': 'totalPremium',
};

export default {
  name: '@larkspur/eztest-steps',
  version: '1.0.0',
  apiVersion: 1,
  setup(api) {
    api.registerStep({
      name: 'larkspur.iban',
      phrase: 'Generate a UK IBAN as {name}',
      example: 'Generate a UK IBAN as iban',
      category: 'Larkspur',
      async run(_page, args) {
        return { [args.name]: ukIban() };
      },
    });
    api.registerStep({
      name: 'larkspur.premium-breakdown',
      phrase: 'Read the premium breakdown into {name}',
      example: 'Read the premium breakdown into premium',
      category: 'Larkspur',
      async run(page, args, ctx) {
        const table = page.getByRole('table', { name: 'Premium breakdown' });
        await table.waitFor({ state: 'visible', timeout: 10_000 });
        const out = {};
        for (const row of await table.locator('tr').all()) {
          const label = ((await row.locator('th').textContent()) ?? '').trim();
          const value = ((await row.locator('td').textContent()) ?? '').trim();
          const key = LABELS[label];
          if (!key) throw new Error(`premium breakdown: unexpected row "${label}" (the screen changed?)`);
          out[key] = Number(value.replace(/[%,]/g, ''));
        }
        const missing = Object.values(LABELS).filter((k) => !(k in out));
        if (missing.length) throw new Error(`premium breakdown: missing ${missing.join(', ')}`);
        ctx.logger.info(`premium breakdown: total ${out.totalPremium}`);
        return { [args.name]: out };
      },
    });
  },
};
