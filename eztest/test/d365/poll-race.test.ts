/** Probes that land mid-navigation are retried, real errors still surface (D365 and Salesforce pollers). */
import { describe, expect, it } from '../support/testkit.js';
import { poll as d365Poll } from '../../src/d365/uci.js';
import { poll as sfPoll } from '../../src/salesforce/lightning.js';

for (const [name, poll] of [['d365', d365Poll], ['salesforce', sfPoll]] as const) {
  describe(`${name} poll`, () => {
    it('retries when the execution context is destroyed by a navigation', async () => {
      let n = 0;
      const v = await poll(async () => {
        n += 1;
        if (n === 1) throw new Error('locator.allInnerTexts: Execution context was destroyed, most likely because of a navigation');
        return 'ok';
      }, 2000);
      expect(v).toBe('ok');
      expect(n).toBe(2);
    });

    it('still throws other errors', async () => {
      await expect(poll(async () => { throw new Error('strict mode violation'); }, 2000)).rejects.toThrow(/strict mode/);
    });
  });
}
