import { describe, expect, it } from '../support/testkit.js';
import { Step } from '../../src/core/index.js';
import { CONDITION_RULES, INTENT_RULES, IntentParseError, parseCondition, parseIntent } from '../../src/intent/index.js';

const p = (line: string) => Step.parse(parseIntent(line));

describe('grammar coverage', () => {
  it('has 60+ rules and every rule example parses with that rule', () => {
    expect(INTENT_RULES.length + CONDITION_RULES.length).toBeGreaterThanOrEqual(60);
    expect(INTENT_RULES.length).toBeGreaterThanOrEqual(55);
    for (const r of INTENT_RULES) expect(() => parseIntent(r.example), r.name).not.toThrow();
  });
});

describe('parseIntent: actions', () => {
  const cases: Array<[string, Partial<Step>]> = [
    ['Open /login', { action: 'navigate', value: '/login' }],
    ['Go to "https://example.com/a b"', { action: 'navigate', value: 'https://example.com/a b' }],
    ['Navigate to /orders/${orderId}', { action: 'navigate', value: '/orders/${orderId}' }],
    ['Visit the page /dashboard', { action: 'navigate', value: '/dashboard' }],
    ['Reload the page', { action: 'navigate', args: { mode: 'reload' } }],
    ['Go back', { action: 'navigate', args: { mode: 'back' } }],
    ['Click the Sign in button', { action: 'click' }],
    ['Then I click on the "Orders" link.', { action: 'click' }],
    ['Tap the Save button', { action: 'click' }],
    ['Press the Save button', { action: 'click' }],
    ['Right-click the Order row', { action: 'click', args: { button: 'right' } }],
    ['Double-click the Order row', { action: 'dblclick' }],
    ['Type "bob" into the Username field', { action: 'fill', value: 'bob' }],
    ["Enter 'Builder#2' in the Password field", { action: 'fill', value: 'Builder#2' }],
    ['Type "  spaced  " into the Notes field', { action: 'fill', value: '  spaced  ' }],
    ['Fill the Quantity field with 2', { action: 'fill', value: '2' }],
    ['Fill "${qty}" into the Quantity field', { action: 'fill', value: '${qty}' }],
    ['Set the Quantity field to 3', { action: 'fill', value: '3' }],
    ['Clear the Search field', { action: 'clear' }],
    ['Select "Gadget" from the Product dropdown', { action: 'select', value: 'Gadget' }],
    ['Choose Contoso Ltd in the Customer dropdown', { action: 'select', value: 'Contoso Ltd' }],
    ['Set the Product dropdown to "Widget"', { action: 'select', value: 'Widget' }],
    ['Check the Remember me checkbox', { action: 'check' }],
    ['Uncheck the Newsletter checkbox', { action: 'uncheck' }],
    ['Select the Express radio button', { action: 'check' }],
    ['Hover over the Help icon', { action: 'hover' }],
    ['Press Enter', { action: 'press', value: 'Enter' }],
    ['Press Control+A in the Notes field', { action: 'press', value: 'Control+A' }],
    ['Upload "fixtures/po.pdf" to the Attachment field', { action: 'upload', value: 'fixtures/po.pdf' }],
    ['Download the "Download invoice" link as invoice', { action: 'download', captureAs: 'invoice' }],
    ['Wait 2 seconds', { action: 'wait', value: '2000' }],
    ['Wait for 250 ms', { action: 'wait', value: '250' }],
    ['Wait for the Orders table to appear', { action: 'wait' }],
    ['Capture the text of testid=order-number as orderNumber', { action: 'capture', captureAs: 'orderNumber', args: { mode: 'text' } }],
    ['Remember the value of the Quantity field as qty', { action: 'capture', captureAs: 'qty', args: { mode: 'value' } }],
    ['Log in as sales rep', { action: 'login', value: 'sales rep' }],
    ['Sign in as manager', { action: 'login', value: 'manager' }],
    ['Use data Customer as customer where region=EU, creditLimit=">10000"', { action: 'useData', args: { entity: 'Customer', as: 'customer', where: { region: 'EU', creditLimit: '>10000' } } }],
    ['Run step "seedCart" with items=3', { action: 'custom', handler: 'seedCart', args: { items: '3' } }],
    ['Compare document invoice to "order ${orderNumber}" and store as check', { action: 'compareDocument', captureAs: 'check', args: { document: 'invoice', against: 'order ${orderNumber}' } }],
  ];
  for (const [line, want] of cases) {
    it(line, () => expect(p(line)).toMatchObject(want));
  }

  it('api calls (quoted, bare, with role, body and capture key)', () => {
    expect(p('Call API `GET /api/orders` as manager and store as orders')).toMatchObject({ action: 'api', captureAs: 'orders', api: { method: 'GET', url: '/api/orders', asRole: 'manager' } });
    expect(p('POST /api/orders with body \'{"qty":2}\' as manager and store as created')).toMatchObject({ api: { method: 'POST', body: { qty: 2 }, asRole: 'manager' }, captureAs: 'created' });
    expect(p('Send a DELETE request to /api/orders/1')).toMatchObject({ api: { method: 'DELETE', url: '/api/orders/1' }, captureAs: 'response' });
  });

  it('db queries keep SQL exactly and parse params', () => {
    const s = p('Run query "SELECT * FROM orders WHERE created_by = ? AND note = \'x y\'" on shop with params \'["bob"]\' as rows');
    expect(s.db).toEqual({ connection: 'shop', sql: "SELECT * FROM orders WHERE created_by = ? AND note = 'x y'", params: ['bob'] });
    expect(p('Query shop with "SELECT 1" as one')).toMatchObject({ db: { connection: 'shop', sql: 'SELECT 1' }, captureAs: 'one' });
  });

  it('quoted keywords are never parsed as grammar', () => {
    const s = p('Type "select Gadget from the list" into the Notes field');
    expect(s.action).toBe('fill');
    expect(s.value).toBe('select Gadget from the list');
  });

  it('annotations set id, optional, timeout and risk', () => {
    expect(p('Click the Save button [id=save optional timeout=5s risk=4]')).toMatchObject({ id: 'save', optional: true, timeoutMs: 5000, risk: 4, intent: 'Click the Save button' });
  });

  it('default ids are slugs of the intent', () => {
    expect(p('Click the "Sign in" button').id).toBe('click-the-sign-in-button');
  });
});

describe('parseIntent: assertions', () => {
  const cases: Array<[string, unknown]> = [
    ['Verify the page contains "Welcome"', { type: 'pageContainsText', value: 'Welcome' }],
    ['Expect page does not contain "Error"', { type: 'pageNotContainsText', value: 'Error' }],
    ['I should see "Order created"', { type: 'pageContainsText', value: 'Order created' }],
    ['I should not see "Invalid"', { type: 'pageNotContainsText', value: 'Invalid' }],
    ['Assert the URL contains "/dashboard"', { type: 'urlContains', value: '/dashboard' }],
    ['Check that the url contains /orders/', { type: 'urlContains', value: '/orders/' }],
    ['Verify the URL matches /orders\\/\\d+/', { type: 'urlMatches', pattern: 'orders\\/\\d+' }],
    ['Verify the title contains "Dashboard"', { type: 'titleContains', value: 'Dashboard' }],
    ['Expect the "Saved" message is visible', { type: 'visible' }],
    ['Expect the Spinner element is hidden', { type: 'hidden' }],
    ['Verify testid=order-status has text "Submitted"', { type: 'textEquals', value: 'Submitted' }],
    ['Verify testid=order-total contains "99"', { type: 'textContains', value: '99' }],
    ['Verify the Quantity field has value "2"', { type: 'valueEquals', value: '2' }],
    ['Ensure the value of the Quantity field is 2', { type: 'valueEquals', value: '2' }],
    ['Verify there are 2 rows in the Recent orders table', { type: 'count', equals: 2 }],
    ['The Recent orders table should have 3 rows', { type: 'count', equals: 3 }],
    ['Verify ${orderNumber} equals "ORD-1"', { type: 'ledgerEquals', key: 'orderNumber', expected: 'ORD-1' }],
    ['Verify ${a} equals ${b}', { type: 'ledgerEquals', key: 'a', otherKey: 'b' }],
    ['Verify response orders status is 200', { type: 'apiStatus', captureKey: 'orders', status: 200 }],
    ['Verify query rows returns 3 rows', { type: 'dbRowCount', captureKey: 'rows', equals: 3 }],
    ['Verify download invoice exists', { type: 'downloadExists', captureKey: 'invoice' }],
  ];
  for (const [line, cond] of cases) {
    it(line, () => {
      const s = p(line);
      expect(s.action).toBe('assert');
      expect(s.postconditions).toHaveLength(1);
      expect(s.postconditions[0]).toMatchObject(cond as object);
    });
  }

  it('count of table rows uses row selectors scoped to the table', () => {
    const c = parseCondition('there are 2 rows in the Recent orders table');
    expect(c).toMatchObject({ type: 'count', target: { locators: [{ strategy: 'css', value: 'table[aria-label="Recent orders"] tbody tr' }, expect.anything()] } });
  });
});

describe('errors', () => {
  it('unparseable lines throw IntentParseError with suggestions', () => {
    try {
      parseIntent('Clik the Save button', { lineNumber: 7 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IntentParseError);
      const err = e as IntentParseError;
      expect(err.message).toMatch(/^line 7: cannot understand "Clik the Save button"/);
      expect(err.lineNumber).toBe(7);
      expect(err.suggestions).toContain('Click the "Sign in" button');
    }
  });
  it('a bad expectation explains what is expected', () => {
    expect(() => parseIntent('Verify the moon is made of cheese')).toThrow(/Cannot understand the expectation/);
  });
  it('empty lines are rejected', () => {
    expect(() => parseIntent('   ')).toThrow(IntentParseError);
  });
});

describe('intent plugins', () => {
  it('lets add-ons register rules that run before built-in ones, and unregister them', async () => {
    const { registerIntentRules, parseIntent } = await import('../../src/intent/index.js');
    const off = registerIntentRules([
      { name: 'demo-plugin', keywords: ['beam'], example: 'Beam me up', re: /^beam\s+me\s+up$/i, build: () => ({ action: 'custom', handler: 'demo.beam' }) },
    ]);
    expect(parseIntent('Beam me up').handler).toBe('demo.beam');
    off();
    expect(() => parseIntent('Beam me up')).toThrow();
  });
});
