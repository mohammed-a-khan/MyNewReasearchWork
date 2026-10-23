/**
 * examples/bdd-project runs as documented: features with and without step
 * definitions, the Identity Vault fallback, a Rule, outlines with tagged
 * Examples blocks and a CSV source, and tag expressions.
 */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { cli, latestRun, tree } from '../sdk/helpers.js';

const EXAMPLE = resolve(__dirname, '../../examples/bdd-project');
let app: DemoServer | undefined;
const saved: Record<string, string | undefined> = {};

afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('examples/bdd-project', () => {
  it('runs every feature; tag expressions pick scenarios and Examples blocks', async () => {
    const project = await mkdtemp(join(tmpdir(), 'eztest-bdd-example-'));
    await cp(EXAMPLE, project, { recursive: true });
    app = await startDemoApp({ dbFile: join(project, 'shop.db') });
    for (const [k, v] of Object.entries({ SHOP_URL: app.url, SHOP_DB: join(project, 'shop.db'), SHOP_BOB_PASSWORD: 'Builder#2' })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const v = await cli(project, ['validate', 'features']);
    expect(v.exitCode, v.err.join('\n')).toBe(0);

    const r = await cli(project, ['run', '--tags', 'not @wip']);
    const { run } = await latestRun(project);
    const all = run.journeys.map((j) => `${j.journeyId} ${j.status}\n${tree(j.steps, 1)}`).join('\n');
    expect(run.journeys.map((j) => j.journeyId).sort(), all).toEqual([
      'orders--order-qty-product-for-customer-1',
      'orders--order-qty-product-for-customer-2',
      'orders--place-an-order',
      'orders--the-eu-customers',
      'quotes--quote-from-a-json-request',
      'quotes--quote-qty-x-sku-sku-200',
      'quotes--quote-qty-x-sku-sku-300',
      'sign-in--a-wrong-password-is-refused',
      'sign-in--sign-in-through-the-identity-vault',
      'sign-in--sign-in-with-the-form',
    ]);
    for (const j of run.journeys) expect(j.status, `${j.journeyId}\n${tree(j.steps)}`).toBe('passed');
    expect(r.exitCode).toBe(0);
    const form = run.journeys.find((j) => j.journeyId === 'sign-in--sign-in-with-the-form')!;
    expect(form.steps.map((s) => s.gherkin?.match)).toEqual(['ez', 'ez', 'ez', 'ez', 'ez']); // the After hook attaches only on failure: an empty one is not listed
    expect(form.steps[1].children!.map((c) => c.intent)).toEqual(['Type "bob" into the "Username" field', 'Type "Builder#2" into the "Password" field']);

    const smoke = await cli(project, ['run', '--tags', '@smoke and @orders']);
    expect(smoke.exitCode).toBe(0);
    expect((await latestRun(project)).run.journeys.map((j) => j.journeyId)).toEqual(['orders--place-an-order']);
  });
});
