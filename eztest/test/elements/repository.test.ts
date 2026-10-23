/** Shared element repository: loading (YAML, JSON, TypeScript screens), binding, usages, duplicates, heal planning, the CLI and SDK ids. */
import { describe, expect, it } from '../support/testkit.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildProgram, type CliIO } from '../../src/cli/program.js';
import {
  bindJourney, duplicateElements, elementUsages, ElementRepository, locatorToString, parseElementFile, planElementHeal, readScreenModule,
} from '../../src/elements/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { memoryKey } from '../../src/runner/step.js';
import { screen, toTarget } from '../../src/sdk/screen.js';
import { tempDir } from '../runner/fixtures.js';

const YAML_FILE = `# Checkout
screen: Checkout
elements:
  placeOrder:
    description: the "Place order" button
    locators:
      - role=button[name="Place order"]
      - testid=place-order
    aliases: [the Checkout button]
  emptyBasket: the "Empty basket" button
  total: testid=order-total or css=#total
  framed:
    description: the card number
    locators: [{strategy: label, value: Card number}]
    frames: ['iframe#pay']
`;

describe('loading', () => {
  it('reads long and short forms with ids, lines, aliases and frames', () => {
    const r = parseElementFile(YAML_FILE, 'elements/checkout.yaml');
    expect(r.problems).toEqual([]);
    const by = Object.fromEntries(r.elements.map((e) => [e.key, e]));
    expect(by.placeOrder).toMatchObject({ id: 'Checkout.placeOrder', line: 4, aliases: ['the Checkout button'], locators: [{ strategy: 'role', value: 'button', name: 'Place order', exact: true }, { strategy: 'testId', value: 'place-order' }] });
    expect(by.emptyBasket.locators[0]).toEqual({ strategy: 'role', value: 'button', name: 'Empty basket', exact: true });
    expect(by.total.locators).toEqual([{ strategy: 'testId', value: 'order-total' }, { strategy: 'css', value: '#total' }]);
    expect(by.framed).toMatchObject({ frames: ['iframe#pay'], locators: [{ strategy: 'label', value: 'Card number' }] });
  });

  it('reports bad entries and keeps the good ones', () => {
    const r = parseElementFile('screen: S\nelements:\n  ok: testid=x\n  bad: { locators: ["not a selector"] }\n  "x y": testid=z\n', 'elements/s.yaml');
    expect(r.elements.map((e) => e.id)).toEqual(['S.ok']);
    expect(r.problems.map((p) => p.message).join('\n')).toMatch(/not a selector[\s\S]*must be a word/);
    expect(parseElementFile('nope: [', 'e.yaml').problems[0].message).toMatch(/cannot read/);
  });

  it('reads TypeScript screens statically (imported and SDK style), skipping functions', async () => {
    const r = await readScreenModule(`import { screen } from 'eztest/sdk';
export const Login = screen('Login page', {
  username: { label: 'Username', testId: 'username' },
  signIn: { description: 'Sign in button', candidates: [{ strategy: 'css', value: '#login-btn' }, { strategy: 'xpath', value: "//button[.='Sign in']" }] },
  plain: 'the "Help" link',
  row: (id: string) => ({ xpath: \`//tr[td='\${id}']\` }),
  computed: { css: '#' + 'x' },
});`, 'screens/Login.ts');
    expect(r.elements.map((e) => e.id)).toEqual(['Login_page.username', 'Login_page.signIn', 'Login_page.plain']);
    expect(r.elements[1].locators.map((l) => l.strategy)).toEqual(['css', 'xpath']);
    expect(r.problems.map((p) => p.message)).toEqual([expect.stringMatching(/row .*computed or a function/), expect.stringMatching(/computed .*computed or a function/)]);
  });

  it('loads a project: YAML wins over a screen with the same id; duplicates across files are reported', async () => {
    const dir = await tempDir('elements');
    await mkdir(join(dir, 'elements'));
    await mkdir(join(dir, 'screens'));
    await writeFile(join(dir, 'elements', 'checkout.yaml'), YAML_FILE);
    await writeFile(join(dir, 'elements', 'again.yaml'), 'screen: Checkout\nelements:\n  total: testid=other\n');
    await writeFile(join(dir, 'screens', 'checkout.ts'), "screen('Checkout', { placeOrder: { css: '#from-screen' }, coupon: { label: 'Coupon' } });");
    const repo = await ElementRepository.load(dir, { screens: ['screens'] });
    expect(repo.get('Checkout.placeOrder')?.source).toBe('yaml');
    expect(repo.get('Checkout.coupon')?.source).toBe('screen');
    expect(repo.get('checkout.PLACEORDER')?.id).toBe('Checkout.placeOrder');
    expect(repo.problems.map((p) => p.message).join('\n')).toMatch(/Checkout.total is defined twice/);
    expect(repo.byDescription('The Checkout button')?.id).toBe('Checkout.placeOrder');
    expect(repo.byDescription('the "Place order" button')?.id).toBe('Checkout.placeOrder');
    expect(new ElementRepository(repo.list(), dir, false).byDescription('the Checkout button')).toBeUndefined();
  });
});

describe('binding and reports', () => {
  const repo = new ElementRepository(parseElementFile(YAML_FILE, 'elements/checkout.yaml').elements);

  it('binds references, descriptions, anchors and conditions; lists unknown references', () => {
    const j = parseEzScript(`Journey: Bind
Click the @Checkout.placeOrder button
Expect the @Checkout.total text has text "39.98"
Click the Checkout button
Click the "Remove" button near @Checkout.total
Click the @Checkout.nothing button
Click the "Help" link
`);
    const { journey, unknown } = bindJourney(j, repo);
    expect(unknown).toEqual(['Checkout.nothing']);
    const [a, b, c, d, help] = journey.steps;
    expect(a.target).toMatchObject({ element: 'Checkout.placeOrder', locators: [{ strategy: 'role', name: 'Place order' }, { strategy: 'testId' }] });
    expect((a.postconditions[0] as { target: { element: string } }).target.element).toBe('Checkout.total');
    expect(b.target).toMatchObject({ element: 'Checkout.placeOrder' });
    expect(c.target?.scope?.[0].anchor).toMatchObject({ element: 'Checkout.total', locators: [{ strategy: 'testId', value: 'order-total' }, expect.anything()] });
    expect(d.target?.locators).toEqual([]);
    expect(help.target?.element).toBeUndefined();
    const usages = elementUsages([j], repo);
    expect(usages.get('Checkout.placeOrder')?.map((u) => u.via)).toEqual(['reference', 'description']);
    expect(usages.get('Checkout.total')?.map((u) => u.role)).toEqual(['expect', 'anchor']);
    expect(usages.get('Checkout.nothing')).toHaveLength(1);
  });

  it('keys memory by element id only for unscoped repository targets', () => {
    expect(memoryKey('j', 's', { element: 'Checkout.placeOrder' })).toEqual(['@elements', 'Checkout.placeOrder']);
    expect(memoryKey('j', 's', { element: 'Checkout.placeOrder', scope: [{}] })).toEqual(['j', 's']);
    expect(memoryKey('j', 's', { element: 'Checkout.placeOrder', nth: 1 })).toEqual(['j', 's']);
    expect(memoryKey('j', 's', {})).toEqual(['j', 's']);
  });

  it('finds duplicates', () => {
    const r = new ElementRepository(parseElementFile(`screen: D
elements:
  a: testid=save
  b: testid=save
  c: { description: the "Save" button, locators: [testid=save, '#save'] }
  d: { description: the "Save" button, locators: ['#x'] }
`, 'elements/d.yaml').elements);
    const g = duplicateElements(r);
    expect(g.find((x) => x.reason === 'same-locators')?.ids).toEqual(['D.a', 'D.b']);
    expect(g.find((x) => x.reason === 'same-locator')?.ids).toEqual(['D.a', 'D.b', 'D.c']);
    expect(g.filter((x) => x.reason === 'same-description').map((x) => x.ids)).toContainEqual(['D.c', 'D.d']);
  });

  it('SDK screens carry their element id; the repository wins when it has the id', () => {
    const S = screen('Checkout', { placeOrder: { css: '#place-order' }, row: (id: string) => ({ xpath: `//tr[td='${id}']` }) });
    expect(S.placeOrder.id).toBe('Checkout.placeOrder');
    expect(toTarget(S.placeOrder)).toMatchObject({ element: 'Checkout.placeOrder', locators: [{ strategy: 'css', value: '#place-order' }] });
    expect(toTarget(S.row('7')).element).toBeUndefined();
    const j = parseEzScript('Journey: X\nPress Tab\n');
    const bound = bindJourney({ ...j, steps: [{ ...j.steps[0], action: 'click', target: toTarget(S.placeOrder) }] }, repo).journey;
    expect(bound.steps[0].target?.locators.map((l) => l.strategy)).toEqual(['role', 'testId', 'css']);
  });
});

describe('accepting a heal into the repository', () => {
  const els = parseElementFile(YAML_FILE, 'elements/checkout.yaml').elements;
  const healed = { strategy: 'role' as const, value: 'button', name: 'Submit order', exact: true };

  it('puts the healed locator first, keeps comments, and verifies the result', () => {
    const el = els.find((e) => e.key === 'placeOrder')!;
    const p = planElementHeal({ element: el, healed, text: YAML_FILE, displayPath: 'elements/checkout.yaml' });
    expect(p.method).toBe('element-yaml');
    const after = p.changes[0].after;
    expect(after).toContain('# Checkout');
    expect(after).toMatch(/locators:\n\s+- role=button\[name="Submit order"\]\n\s+- role=button\[name="Place order"\]/);
    expect(p.changes[0].diff.filter((l) => l.kind === '+').map((l) => l.text.trim())).toEqual(['- role=button[name="Submit order"]']);
    const back = parseElementFile(after, 'elements/checkout.yaml').elements.find((e) => e.key === 'placeOrder')!;
    expect(back.locators[0]).toEqual(healed);
    // Planning the same heal again is a no-op.
    expect(planElementHeal({ element: back, healed, text: after, displayPath: 'elements/checkout.yaml' }).alreadyApplied).toBe(true);
  });

  it('turns a short-form entry into description + locators, and an existing locator moves up', () => {
    const el = els.find((e) => e.key === 'total')!;
    const p = planElementHeal({ element: el, healed: { strategy: 'css', value: '#total' }, text: YAML_FILE, displayPath: 'elements/checkout.yaml' });
    const back = parseElementFile(p.changes[0].after, 'x.yaml').elements.find((e) => e.key === 'total')!;
    expect(back.locators).toEqual([{ strategy: 'css', value: '#total' }, { strategy: 'testId', value: 'order-total' }]);
    expect(p.notes[0]).toMatch(/short-form entry/);
  });

  it('writes an override file for an element from a TypeScript screen; objects for locators without a string form', async () => {
    const { elements } = await readScreenModule("screen('Pay', { card: { label: 'Card number' } });", 'screens/pay.ts');
    const p = planElementHeal({ element: elements[0], healed: { strategy: 'placeholder', value: 'Card', exact: true }, text: '', displayPath: 'elements/Pay.yaml', existed: false });
    expect(p.method).toBe('element-override');
    expect(p.changes[0].existed).toBe(false);
    const back = parseElementFile(p.changes[0].after, 'elements/Pay.yaml').elements[0];
    expect(back).toMatchObject({ id: 'Pay.card', locators: [{ strategy: 'placeholder', value: 'Card' }, { strategy: 'label', value: 'Card number' }] });
    expect(locatorToString({ strategy: 'placeholder', value: 'Card' })).toBeUndefined();
    expect(locatorToString({ strategy: 'testId', value: 'a.b' })).toBe('testid=a.b');
    expect(locatorToString({ strategy: 'css', value: '#x' })).toBe('#x');
    expect(locatorToString({ strategy: 'xpath', value: '//a' })).toBe('xpath=//a');
  });
});

describe('eztest elements', () => {
  async function cli(cwd: string, args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIO = { out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: { ...process.env } };
    process.exitCode = 0;
    await buildProgram(io).parseAsync(['node', 'eztest', ...args], { from: 'node' });
    const code = Number(process.exitCode ?? 0);
    process.exitCode = 0;
    return { out: out.join('\n'), err: err.join('\n'), code };
  }

  it('list, unused, duplicates and import-screens', async () => {
    const dir = await tempDir('elements-cli');
    await mkdir(join(dir, 'elements'));
    await mkdir(join(dir, 'journeys'));
    await mkdir(join(dir, 'screens'));
    await writeFile(join(dir, 'eztest.config.yaml'), 'baseUrl: http://127.0.0.1:9\n');
    await writeFile(join(dir, 'elements', 'checkout.yaml'), YAML_FILE + '  again: testid=order-total or css=#total\n');
    await writeFile(join(dir, 'journeys', 'a.ez'), 'Journey: A\nClick the @Checkout.placeOrder button\nClick the "Empty basket" button\nClick the @Checkout.gone button\n');
    await writeFile(join(dir, 'screens', 'Orders.ts'), "import { screen } from 'eztest/sdk';\nexport const O = screen('Orders', { search: { css: '#q', label: 'Search' }, row: (id: string) => ({ xpath: id }) });\n");
    const list = await cli(dir, ['elements', 'list']);
    expect(list.out).toMatch(/@Checkout.placeOrder {2}the "Place order" button {2}\(1 use in 1 journey; elements\/checkout.yaml:4\)/);
    expect(list.out).toMatch(/5 elements/);
    const json = JSON.parse((await cli(dir, ['elements', 'list', '--json'])).out);
    expect(json.find((e: { id: string }) => e.id === 'Checkout.emptyBasket').usages).toBe(1);
    const unused = await cli(dir, ['elements', 'unused']);
    expect(unused.out).toMatch(/@Checkout.total/);
    expect(unused.out).toMatch(/unknown: @Checkout.gone is used by A/);
    expect(unused.code).toBe(1);
    const dup = await cli(dir, ['elements', 'duplicates', '--strict']);
    expect(dup.out).toMatch(/same locators: @Checkout.again, @Checkout.total/);
    expect(dup.code).toBe(1);
    const imp = await cli(dir, ['elements', 'import-screens']);
    expect(imp.out).toMatch(/wrote elements\/Orders.yaml \(1 element\)/);
    expect(imp.err).toMatch(/skipped: Orders.row/);
    const yaml = await readFile(join(dir, 'elements', 'Orders.yaml'), 'utf8');
    expect(yaml).toMatch(/screen: Orders[\s\S]*search:[\s\S]*- css=#q|- "#q"/);
    expect((await ElementRepository.load(dir)).get('Orders.search')?.locators).toEqual([{ strategy: 'css', value: '#q' }, { strategy: 'label', value: 'Search' }]);
    expect((await cli(dir, ['elements', 'import-screens'])).err).toMatch(/exists, not overwritten/);
  });
});
