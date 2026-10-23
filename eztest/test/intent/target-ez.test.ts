import { describe, expect, it } from '../support/testkit.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { NotSupportedError, parseJourney } from '../../src/core/index.js';
import { IntentParseError, describeTarget, journeyToEzScript, loadJourneyFile, parseEzScript } from '../../src/intent/index.js';

describe('describeTarget', () => {
  it('the Sign in button -> role button + text', () => {
    expect(describeTarget('the Sign in button')).toEqual({
      description: 'the Sign in button',
      locators: [
        { strategy: 'role', value: 'button', name: 'Sign in', exact: true },
        { strategy: 'text', value: 'Sign in', exact: true },
      ],
    });
  });
  it('fields -> label, placeholder, role textbox', () => {
    for (const d of ['the Username field', 'the "Username" input', 'Username box']) {
      expect(describeTarget(d).locators.map((l) => l.strategy)).toEqual(['label', 'placeholder', 'role']);
      expect(describeTarget(d).locators[0].value).toBe('Username');
    }
  });
  it('links, dropdowns, checkboxes, headings, images', () => {
    expect(describeTarget('the Orders link').locators[0]).toEqual({ strategy: 'role', value: 'link', name: 'Orders', exact: true });
    expect(describeTarget('the Product dropdown').locators[0]).toMatchObject({ strategy: 'label', value: 'Product' });
    expect(describeTarget('the Remember me checkbox').locators[0]).toMatchObject({ strategy: 'role', value: 'checkbox', name: 'Remember me' });
    expect(describeTarget('the Dashboard heading').locators[0]).toMatchObject({ strategy: 'role', value: 'heading' });
    expect(describeTarget('the Company logo').locators.map((l) => l.strategy)).toEqual(['role', 'altText']);
    expect(describeTarget('the radio button labelled "Express"').locators[0]).toMatchObject({ strategy: 'role', value: 'radio', name: 'Express' });
  });
  it('quoted text -> text first', () => {
    expect(describeTarget('"Order created"').locators[0]).toEqual({ strategy: 'text', value: 'Order created', exact: true });
  });
  it('selector passthroughs', () => {
    expect(describeTarget('#login-btn').locators).toEqual([{ strategy: 'css', value: '#login-btn' }]);
    expect(describeTarget('form#login > button').locators).toEqual([{ strategy: 'css', value: 'form#login > button' }]);
    expect(describeTarget('css=div.a span').locators).toEqual([{ strategy: 'css', value: 'div.a span' }]);
    expect(describeTarget('xpath=//button[1]').locators).toEqual([{ strategy: 'xpath', value: '//button[1]' }]);
    expect(describeTarget('//a[@id="x"]').locators).toEqual([{ strategy: 'xpath', value: '//a[@id="x"]' }]);
    expect(describeTarget('testid=order-number').locators).toEqual([{ strategy: 'testId', value: 'order-number' }]);
    expect(describeTarget('role=button[name="Save"]').locators).toEqual([{ strategy: 'role', value: 'button', name: 'Save', exact: true }]);
    expect(describeTarget('the element with test id order-total').locators).toEqual([{ strategy: 'testId', value: 'order-total' }]);
  });
  it('keeps ${var} placeholders and the human description', () => {
    const t = describeTarget('the ${orderNumber} link');
    expect(t.description).toBe('the ${orderNumber} link');
    expect(t.locators[0]).toMatchObject({ name: '${orderNumber}' });
  });
  it('rejects empty descriptions', () => {
    expect(() => describeTarget('  ')).toThrow();
  });
});

const SCRIPT = `# A comment
Journey: Bob creates an order
Tags: @smoke @orders
Role: manager
Requirements: R-1, R-2
Risk: 4
Base URL: http://localhost:4600
Variables: user=bob, greeting="hello, world"
Data: Customer as customer where region=EU

Verify the page contains "Sign in"
Open /login
Type "\${user}" into the Username field
Click the "Sign in" button
  Expect the URL contains "/dashboard"
  And expect the "Welcome" text is visible
Then verify page does not contain "Invalid"
Capture the text of testid=welcome-user as who
Assert that \${who} equals "bob"
  And expect the title contains "Dashboard"
Wait until the URL contains "/dashboard"
Call API "GET /api/orders" as manager and store as orders
  Expect response orders status is 200
Run query "SELECT * FROM orders" on shop as rows
Click the Save button [id=save optional timeout=2s risk=5]
Click the Save button
`;

describe('.ez scripts', () => {
  it('parses headers, steps and Expect lines as post-conditions of the preceding action', () => {
    const j = parseEzScript(SCRIPT);
    expect(j).toMatchObject({
      id: 'bob-creates-an-order', name: 'Bob creates an order', tags: ['smoke', 'orders'], role: 'manager',
      requirements: ['R-1', 'R-2'], risk: 4, baseUrl: 'http://localhost:4600', variables: { user: 'bob', greeting: 'hello, world' },
      data: [{ entity: 'Customer', as: 'customer', where: { region: 'EU' } }],
    });
    // A leading Verify with nothing before it is a standalone assert step.
    expect(j.steps[0]).toMatchObject({ action: 'assert', postconditions: [{ type: 'pageContainsText', value: 'Sign in' }] });
    const click = j.steps.find((s) => s.id === 'click-the-sign-in-button')!;
    expect(click.postconditions.map((c) => c.type)).toEqual(['urlContains', 'visible', 'pageNotContainsText']);
    expect(j.steps.find((s) => s.action === 'fill')?.value).toBe('${user}');
    const assertStep = j.steps.find((s) => s.action === 'assert' && s.id !== j.steps[0].id)!;
    expect(assertStep.postconditions.map((c) => c.type)).toEqual(['ledgerEquals', 'titleContains']);
    expect(j.steps.find((s) => s.id === 'save')).toMatchObject({ optional: true, timeoutMs: 2000, risk: 5 });
    // Duplicate intents get unique ids.
    expect(j.steps.at(-1)!.id).toBe('click-the-save-button');
    expect(new Set(j.steps.map((s) => s.id)).size).toBe(j.steps.length);
  });

  it('round-trips through journeyToEzScript', () => {
    const j = parseEzScript(SCRIPT);
    const text = journeyToEzScript(j);
    const again = parseEzScript(text);
    expect(again).toEqual(j);
    expect(journeyToEzScript(again)).toBe(text);
  });

  it('renders structured (YAML-style) journeys with generated intents', () => {
    const j = parseJourney({
      id: 'x', name: 'Structured', steps: [
        { id: 'go', intent: 'go to the login screen', action: 'navigate', value: '/login' },
        { id: 'who', intent: 'type user', action: 'fill', value: 'bob', target: describeTarget('the Username field') },
        { id: 'chk', intent: 'confirm', action: 'assert', postconditions: [{ type: 'urlContains', value: '/login' }, { type: 'pageContainsText', value: 'Sign in' }] },
      ],
    });
    const text = journeyToEzScript(j);
    expect(text).toContain('Open "/login" [id=go]');
    expect(text).toContain('Assert that URL contains "/login" [id=chk]');
    const again = parseEzScript(text);
    expect(again.steps.map((s) => [s.id, s.action, s.value, s.postconditions.length])).toEqual(j.steps.map((s) => [s.id, s.action, s.value, s.postconditions.length]));
    expect(again.steps[1].target?.locators).toEqual(j.steps[1].target?.locators);
  });

  it('refuses to render steps .ez cannot express', () => {
    const j = parseJourney({ id: 'x', name: 'X', steps: [{ id: 'a', intent: 'odd', action: 'click', target: { description: 'the thing', locators: [{ strategy: 'css', value: '.weird' }] } }] });
    expect(() => journeyToEzScript(j)).toThrow(/cannot be expressed in \.ez/);
  });

  it('reports errors with line numbers and suggestions', () => {
    const bad = 'Journey: Broken\nOpen /login\n\nClikc the Sign in button\n';
    try {
      parseEzScript(bad, { source: 'broken.ez' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IntentParseError);
      expect((e as IntentParseError).message).toMatch(/^broken\.ez:line 4: cannot understand "Clikc the Sign in button"/);
      expect((e as IntentParseError).lineNumber).toBe(4);
      expect((e as IntentParseError).suggestions.length).toBeGreaterThan(0);
    }
    expect(() => parseEzScript('Journey: X\nClick the Go button\n  Expect the moon is cheese')).toThrow(/line 3: Cannot understand the expectation/);
    expect(() => parseEzScript('Open /login')).toThrow(/missing "Journey: <name>"/);
    expect(() => parseEzScript('Journey: Empty\n# nothing')).toThrow(/has no steps/);
    expect(() => parseEzScript('Journey: R\nRisk: 9\nOpen /')).toThrow(/line 2: Risk must be/);
  });
});

describe('loadJourneyFile', () => {
  it('loads .ez, .yaml and .json; unknown extensions are NotSupported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-intent-'));
    await writeFile(join(dir, 'a.ez'), 'Journey: From ez\nOpen /login\n');
    await writeFile(join(dir, 'b.yaml'), [
      'name: From yaml',
      'tags: ["@smoke"]',
      'steps:',
      '  - Open /login',
      '  - intent: Click the "Sign in" button',
      '    expect:',
      '      - the URL contains "/dashboard"',
      '  - id: custom-fill',
      '    intent: put the user in',
      '    action: fill',
      '    value: bob',
      '    target: the Username field',
    ].join('\n'));
    await writeFile(join(dir, 'c.json'), JSON.stringify({ name: 'From json', steps: ['Open /x', 'Verify page contains "x"'] }));
    await writeFile(join(dir, 'd.txt'), 'nope');
    const a = await loadJourneyFile(join(dir, 'a.ez'));
    expect(a).toMatchObject({ id: 'from-ez', steps: [{ action: 'navigate', value: '/login' }] });
    const b = await loadJourneyFile(join(dir, 'b.yaml'));
    expect(b.tags).toEqual(['smoke']);
    expect(b.steps[1]).toMatchObject({ action: 'click', postconditions: [{ type: 'urlContains', value: '/dashboard' }] });
    expect(b.steps[2]).toMatchObject({ id: 'custom-fill', action: 'fill', target: { locators: [{ strategy: 'label', value: 'Username' }, expect.anything(), expect.anything()] } });
    const c = await loadJourneyFile(join(dir, 'c.json'));
    expect(c.steps.map((s) => s.action)).toEqual(['navigate', 'assert']);
    await expect(loadJourneyFile(join(dir, 'd.txt'))).rejects.toBeInstanceOf(NotSupportedError);
  });
});
