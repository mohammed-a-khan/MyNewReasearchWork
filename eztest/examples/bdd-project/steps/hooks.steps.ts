/** Hooks for the EZ Shop features: tag-filtered Before hooks and an After hook that keeps a note on failure. */
import { After, Before } from 'eztest/bdd';

Before({ tags: '@api', name: 'the quote API answers' }, async ({ api, expect }) => {
  const res = await api.post('/api/public/quote', { sku: 'SKU-100', qty: 1 }, { allowErrors: true });
  await expect(res.status, 'quote API status').toBe(200);
});

After(async ({ result, scenario, attach }) => {
  if (result?.status === 'failed') await attach('failure.txt', `${scenario.feature} / ${scenario.name}: ${result.error?.message ?? 'failed'}`);
});
