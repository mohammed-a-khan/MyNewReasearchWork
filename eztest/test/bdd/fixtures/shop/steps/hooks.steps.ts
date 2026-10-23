/** Hooks and the World for the EZ Shop features (synthetic fixture of the native BDD tests). */
import { After, AfterAll, AfterStep, Before, BeforeAll, BeforeStep, Given, setWorldConstructor } from 'eztest/bdd';

class ShopWorld {
  readonly shop: string;
  readonly log: string[] = [];
  constructor({ parameters }: { parameters: Record<string, unknown> }) {
    this.shop = String(parameters.shop ?? '');
  }
}
setWorldConstructor(ShopWorld);

const log = (w: unknown) => (w as ShopWorld).log;

Before(function ({ world }) {
  log(world).push(`before:${(world as ShopWorld).shop}`);
});

Before({ tags: '@api', name: 'api scenarios', order: 1 }, ({ world }) => {
  log(world).push('before-api');
});

BeforeStep('@hooks', ({ world, gherkinStep }) => {
  log(world).push(`step:${gherkinStep?.line}`);
});

AfterStep('@hooks', ({ world, result }) => {
  log(world).push(`after-step:${result?.status}`);
});

// Once per run, for the @api scenarios: the unit price of SKU-100, handed to their Worlds.
BeforeAll({ tags: '@api', name: 'price list' }, async ({ api, shared }) => {
  const r = await api.post<{ total: string }>('/api/public/quote', { sku: 'SKU-100', qty: 1 }, { expectStatus: 200 });
  shared.unitPrice = r.body.total;
});

BeforeAll('@broken-setup', () => {
  throw new Error('setup service down');
});

AfterAll({ name: 'report shared values' }, async ({ shared, attach }) => {
  await attach('shared.json', JSON.stringify(shared));
});

After(async ({ world, vars, result, attach }) => {
  log(world).push(`after:${result?.status}`);
  vars.set('hookLog', [...log(world)]);
  vars.set('unitPrice', (world as { unitPrice?: string }).unitPrice ?? null);
  await attach('world-log.json', JSON.stringify(log(world)));
});

Given('a duplicated step', () => undefined);
Given(/^a duplicated step$/, () => undefined);

Given('the step throws {string}', (_ctx, message: string) => {
  throw new Error(message);
});
