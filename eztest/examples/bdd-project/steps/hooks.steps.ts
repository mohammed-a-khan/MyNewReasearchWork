/**
 * Hooks for the EZ Shop features: a BeforeAll that runs once per run for the @api scenarios and hands
 * a value to their Worlds, and an After hook that keeps a note on failure (it is listed only then).
 */
import { After, BeforeAll } from '@mohammed-a-khan/eztest/bdd';

BeforeAll({ tags: '@api', name: 'the quote API answers' }, async ({ api, expect, shared }) => {
  const res = await api.post<{ total: string }>('/api/public/quote', { sku: 'SKU-100', qty: 1 }, { allowErrors: true });
  await expect(res.status, 'quote API status').toBe(200);
  shared.widgetPrice = res.body.total;
});

After(async ({ result, scenario, attach }) => {
  if (result?.status === 'failed') await attach('failure.txt', `${scenario.feature} / ${scenario.name}: ${result.error?.message ?? 'failed'}`);
});
