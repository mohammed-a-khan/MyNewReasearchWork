/**
 * Native BDD building blocks: step expressions, parameter types, regex
 * definitions, tag expressions, snippets, hook order, the plain-English
 * fallback and the feature -> journey compilation (outlines, tags, ids).
 */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import {
  After, AfterStep, Before, BeforeStep, DataTable, ExpressionSyntaxError, Given, ParameterTypeRegistry, TagExpressionError, Then, When,
  defineParameterType, evaluateTags, ezFallback, featureJourneys, glueOf, hooksFor, isTagExpression, matchStep, parseTagExpression,
  resetBddRegistry, snippet, snippetExpression, stepExpression, tagExpressionToText, tagFilterFrom,
} from '../../src/bdd/index.js';
import { filterJourneys } from '../../src/cli/journeys.js';

const reg = () => new ParameterTypeRegistry();
const args = (pattern: string | RegExp, text: string, r = reg()) => stepExpression(pattern, r).match(text)?.args ?? null;

describe('step expressions', () => {
  it('built-in parameters: {int} {float} {string} {word} {}', () => {
    expect(args('the customer {string} has {int} orders', 'the customer "Acme Ltd" has 3 orders')).toEqual(['Acme Ltd', 3]);
    expect(args('the customer {string} has {int} orders', "the customer 'O\\'Neil' has -2 orders")).toEqual(["O'Neil", -2]);
    expect(args('it costs {float}', 'it costs 49.50')).toEqual([49.5]);
    expect(args('it costs {float}', 'it costs .5')).toEqual([0.5]);
    expect(args('it costs {float}', 'it costs 3')).toEqual([3]);
    expect(args('I pick {word}', 'I pick gold-tier')).toEqual(['gold-tier']);
    expect(args('I pick {word}', 'I pick gold tier')).toBeNull();
    expect(args('anything {} here', 'anything at all here')).toEqual(['at all']);
    expect(args('a string {string}', 'a string "with \\"escaped\\" quotes"')).toEqual(['with "escaped" quotes']);
    expect(args('n is {bigint}', 'n is 12345678901234567890')).toEqual([12345678901234567890n]);
    expect(args('{int} items', '3 items extra')).toBeNull();
  });

  it('optional text, alternatives and escapes', () => {
    expect(args('I have {int} cucumber(s)', 'I have 1 cucumber')).toEqual([1]);
    expect(args('I have {int} cucumber(s)', 'I have 5 cucumbers')).toEqual([5]);
    expect(args('I pay by card/cash/cheque', 'I pay by cash')).toEqual([]);
    expect(args('I pay by card/cash', 'I pay by bitcoin')).toBeNull();
    expect(args('the {word} order(s) in my basket/cart', 'the open orders in my cart')).toEqual(['open']);
    expect(args('it costs \\{price\\} \\(net\\) and/or', 'it costs {price} (net) and/or')).toBeNull();
    expect(args('it costs \\{price\\} \\(net\\) a\\/b', 'it costs {price} (net) a/b')).toEqual([]);
    expect(args('a.b*c+d?', 'a.b*c+d?')).toEqual([]);
    expect(args('a.b', 'axb')).toBeNull();
  });

  it('custom parameter types with transformers, several alternatives and capture groups', () => {
    const r = reg();
    r.define({ name: 'color', regexp: /red|green|blue/, transformer: (s) => s.toUpperCase() });
    r.define({ name: 'money', regexp: [/(\d+)\.(\d\d) EUR/, /(\d+) EUR/], transformer: (a, b) => Number(a) * 100 + Number(b ?? 0) });
    expect(args('a {color} car', 'a green car', r)).toEqual(['GREEN']);
    expect(args('a {color} car', 'a pink car', r)).toBeNull();
    expect(args('it costs {money}', 'it costs 12.50 EUR', r)).toEqual([1250]);
    expect(args('it costs {money}', 'it costs 7 EUR', r)).toEqual([700]);
    expect(() => r.define({ name: 'int', regexp: /\d/ })).toThrow(/built-in/);
  });

  it('regular expressions: groups matching a parameter type are converted, the others stay strings', () => {
    expect(args(/^I have (\d+) (\w+)s?$/, 'I have 4 apples')).toEqual([4, 'apples']);
    expect(args(/^I owe (-?\d+)$/, 'I owe -3')).toEqual([-3]);
    expect(args(/^it costs ([-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?)$/, 'it costs 2.5')).toEqual([2.5]);
    expect(args(/^optional( group)?$/, 'optional')).toEqual([undefined]);
    expect(args(/^(\d+\.\d+) and (\d{3})$/, '1.25 and 007')).toEqual(['1.25', '007']);
    // Only top-level groups are arguments; nested and non-capturing groups are part of them.
    expect(args(/^pay ((\d+) EUR)(?: now)?$/, 'pay 30 EUR now')).toEqual(['30 EUR']);
    expect(stepExpression(/^x (\d+) (y)$/, reg()).parameters).toEqual(['int', '']);
  });

  it('regular expressions: named groups pick a parameter type, custom ones too', () => {
    const r = reg();
    r.define({ name: 'money', regexp: /(\d+)\.(\d\d)/, transformer: (a, b) => Number(a) * 100 + Number(b) });
    r.define({ name: 'color', regexp: /red|blue/, transformer: (s) => s.toUpperCase() });
    expect(args(/^pay (?<money>\S+) for (?<int>\d+) (?<color>\w+) items$/, 'pay 12.50 for 3 red items', r)).toEqual([1250, 3, 'RED']);
    expect(args(/^a (?<float>[\d.]+) and (?<word>\S+) and "(?<string>[^"]*)"$/, 'a 1.5 and x-y and "q"', r)).toEqual([1.5, 'x-y', 'q']);
    expect(args(/^a (?<name>\w+)$/, 'a bob', r)).toEqual(['bob']);
    // A custom type's own regexp converts an unnamed group as well.
    expect(args(/^the (red|blue) car$/, 'the blue car', r)).toEqual(['BLUE']);
    expect(stepExpression(/^(?<money>\S+) (?<other>\w+)$/, r).parameters).toEqual(['money', '']);
  });

  it('reports bad expressions with a column', () => {
    const err = (p: string) => {
      try {
        stepExpression(p, reg());
      } catch (e) {
        return e as ExpressionSyntaxError;
      }
      throw new Error('no error');
    };
    expect(err('a {unknown} b').message).toMatch(/undefined parameter type \{unknown\}.*/);
    expect(err('a {unknown} b').column).toBe(3);
    expect(err('a (b').message).toMatch(/"\(" is not closed/);
    expect(err('a ({int})').message).toMatch(/cannot contain a parameter/);
    expect(err('a/ b').message).toMatch(/text on both sides/);
    expect(err('a \\x').message).toMatch(/can be escaped/);
    expect(err('a }').column).toBe(3);
  });

  it('match spans point into the text', () => {
    const m = stepExpression('pay {int} to {string}', reg()).match('pay 30 to "Bob"')!;
    expect(m.spans.map((s) => [s.start, s.end, s.parameter])).toEqual([[4, 6, 'int'], [10, 15, 'string']]);
  });
});

describe('tag expressions', () => {
  const ev = (e: string, tags: string[]) => evaluateTags(parseTagExpression(e), tags);

  it('and, or, not, parentheses and precedence', () => {
    expect(ev('@smoke and not @wip', ['@smoke'])).toBe(true);
    expect(ev('@smoke and not @wip', ['@smoke', '@wip'])).toBe(false);
    expect(ev('@a or @b and @c', ['@a'])).toBe(true);
    expect(ev('(@a or @b) and @c', ['@a'])).toBe(false);
    expect(ev('not @a or @b', ['@b', '@a'])).toBe(true);
    expect(ev('not (@a or @b)', ['@b'])).toBe(false);
    expect(ev('', [])).toBe(true);
    expect(ev('@Smoke', ['smoke'])).toBe(true);
    expect(ev('@with\\(paren\\)', ['@with(paren)'])).toBe(true);
    expect(tagExpressionToText(parseTagExpression('not (@a or @b) and @c'))).toBe('not (@a or @b) and @c');
  });

  it('reports syntax errors with a column', () => {
    const col = (e: string) => {
      try {
        parseTagExpression(e);
      } catch (x) {
        return [(x as TagExpressionError).column, (x as Error).message];
      }
      return undefined;
    };
    expect(col('@a and')).toEqual([7, expect.stringMatching(/expected a tag/)]);
    expect(col('(@a or @b')).toEqual([10, expect.stringMatching(/missing "\)"/)]);
    expect(col('@a @b')).toEqual([4, expect.stringMatching(/expected "and" or "or"/)]);
    expect(col('@a )')).toEqual([4, expect.stringMatching(/unmatched/)]);
  });

  it('the --tags option takes lists and expressions; filterJourneys uses it', () => {
    expect(isTagExpression('@smoke and not @wip')).toBe(true);
    expect(isTagExpression('smoke,regression')).toBe(false);
    expect(isTagExpression('not-ready')).toBe(false);
    const any = tagFilterFrom(['smoke', 'regression'])!;
    expect(any(['regression'])).toBe(true);
    expect(any(['other'])).toBe(false);
    const js = [
      { id: 'a', name: 'a', tags: ['smoke'] }, { id: 'b', name: 'b', tags: ['smoke', 'wip'] }, { id: 'c', name: 'c', tags: ['regression'] },
    ] as unknown as Parameters<typeof filterJourneys>[0];
    expect(filterJourneys(js, { tags: ['@smoke and not @wip'] }).map((j) => j.id)).toEqual(['a']);
    expect(filterJourneys(js, { tags: ['smoke', 'regression'] }).map((j) => j.id)).toEqual(['a', 'b', 'c']);
    expect(filterJourneys(js, { tags: ['(@smoke or @regression) and not @wip'], exclude: ['regression'] }).map((j) => j.id)).toEqual(['a']);
  });
});

describe('snippets for undefined steps', () => {
  it('turn quoted text and numbers into parameters', () => {
    expect(snippetExpression('the customer "Acme" has 3 orders worth 9.50').expression).toBe('the customer {string} has {int} orders worth {float}');
    expect(snippetExpression('a (b) {c} d/e').expression).toBe('a \\(b\\) \\{c\\} d\\/e');
    const s = snippet({ text: 'the customer "Acme" has 3 orders', type: 'context' });
    expect(s).toBe([
      "Given('the customer {string} has {int} orders', async ({ ui, api, db, world }, string, int) => {",
      '  // Turn the phrase above into ui / api / db calls.',
      "  throw new Error('pending');",
      '});',
    ].join('\n'));
    expect(snippet({ text: 'pay "a" and "b"', type: 'action', hasDataTable: true })).toMatch(/^When\('pay \{string\} and \{string\}', async \(\{ ui, api, db, world \}, string, string2, dataTable\)/);
    expect(snippet({ text: "the user's name", type: 'outcome', hasDocString: true })).toMatch(/^Then\(`the user's name`, async \(\{ ui, api, db, world \}, docString\)/);
  });

  it('use custom parameter types marked for snippets', () => {
    const r = reg();
    r.define({ name: 'color', regexp: /red|green/ });
    expect(snippetExpression('a red car', r).expression).toBe('a {color} car');
  });
});

describe('the step definition registry', () => {
  afterEach(() => resetBddRegistry());

  it('matches across keywords and reports ambiguity', () => {
    Given('the customer {string} has {int} orders', () => undefined);
    When(/^the customer "([^"]+)" has (\d+) orders$/, () => undefined);
    Then('something else', () => undefined);
    const glue = glueOf([]);
    expect(glue.errors).toEqual([]);
    expect(matchStep(glue, 'the customer "A" has 2 orders').map((m) => m.args)).toEqual([['A', 2], ['A', 2]]);
    expect(matchStep(glue, 'something else').length).toBe(1);
    expect(matchStep(glue, 'nothing').length).toBe(0);
  });

  it('defines parameter types before compiling patterns; bad patterns are errors', () => {
    Given('a {fruit}', () => undefined);
    defineParameterType({ name: 'fruit', regexp: /apple|pear/, transformer: (s: string) => ({ fruit: s }) });
    Given('broken {nope}', () => undefined);
    const glue = glueOf([]);
    expect(matchStep(glue, 'a pear')[0].args).toEqual([{ fruit: 'pear' }]);
    expect(glue.errors.join('\n')).toMatch(/undefined parameter type \{nope\}/);
  });

  it('orders hooks: Before by order then registration, After in reverse; tag filters apply', () => {
    const order: string[] = [];
    Before(() => void order.push('b1'));
    Before({ order: 5, name: 'first' }, () => void order.push('b0'));
    Before('@db and not @readonly', () => void order.push('bdb'));
    After(() => void order.push('a1'));
    After('@db', () => void order.push('a2'));
    BeforeStep(() => undefined);
    AfterStep('@x', () => undefined);
    const glue = glueOf([]);
    const run = (kind: 'before' | 'after', tags: string[]) => hooksFor(glue, kind, tags).map((h) => h.fn.call({}, {} as never));
    run('before', ['db']);
    run('after', ['@db']);
    expect(order).toEqual(['b0', 'b1', 'bdb', 'a2', 'a1']);
    order.length = 0;
    run('before', ['db', 'readonly']);
    run('after', []);
    expect(order).toEqual(['b0', 'b1', 'a1']);
    expect(hooksFor(glue, 'beforeStep', []).length).toBe(1);
    expect(hooksFor(glue, 'afterStep', []).length).toBe(0);
    expect(hooksFor(glue, 'before', [])[0].name).toBe('first');
  });

  it('data tables', () => {
    const t = new DataTable([['name', 'email'], ['Ann', 'a@x'], ['Bo', 'b@x']]);
    expect(t.hashes()).toEqual([{ name: 'Ann', email: 'a@x' }, { name: 'Bo', email: 'b@x' }]);
    expect(t.rows()).toEqual([['Ann', 'a@x'], ['Bo', 'b@x']]);
    expect(t.rowsHash()).toEqual({ name: 'email', Ann: 'a@x', Bo: 'b@x' });
    expect(t.transpose().raw()).toEqual([['name', 'Ann', 'Bo'], ['email', 'a@x', 'b@x']]);
    expect(() => new DataTable([['a', 'b', 'c']]).rowsHash()).toThrow(/two columns/);
    expect(JSON.stringify(t)).toBe('[["name","email"],["Ann","a@x"],["Bo","b@x"]]');
  });
});

describe('the plain-English fallback', () => {
  it('runs EZTest phrasings without glue code', () => {
    const click = ezFallback({ text: 'I click the "Save" button', type: 'action' })!;
    expect(click.steps[0].action).toBe('click');
    expect(click.kind).toBe('action');
    const contains = ezFallback({ text: 'the page contains "Saved"', type: 'outcome' })!;
    expect(contains.steps[0].action).toBe('assert');
    expect(contains.steps[0].postconditions?.[0]).toMatchObject({ type: 'pageContainsText', value: 'Saved' });
    expect(contains.lines).toEqual(['Expect the page contains "Saved"']);
    expect(ezFallback({ text: 'I am on the "/login" page', type: 'context' })!.lines).toEqual(['Open "/login"']);
    expect(ezFallback({ text: 'I am logged in as "manager"', type: 'context' })!.steps[0].action).toBe('login');
    expect(ezFallback({ text: 'I should be on "/dashboard"', type: 'outcome' })!.steps[0].postconditions?.[0]).toMatchObject({ type: 'urlContains', value: '/dashboard' });
    expect(ezFallback({ text: 'I type "bob" into the "Username" field', type: 'action' })!.steps[0]).toMatchObject({ action: 'fill', value: 'bob' });
  });

  it('domain steps are not guessed', () => {
    for (const t of ['the customer "Acme" has 3 orders', 'the total is 49.50', 'I create an invoice for "Acme"', 'the refund is accepted']) {
      expect(ezFallback({ text: t, type: 'context' })).toBeUndefined();
      expect(ezFallback({ text: t, type: 'outcome' })).toBeUndefined();
    }
  });

  it('a one-line doc string becomes quoted text; a two-column table fills a form', () => {
    expect(ezFallback({ text: 'the page contains:', type: 'outcome', docString: { content: 'Order saved' } })!.lines).toEqual(['Expect the page contains "Order saved"']);
    expect(ezFallback({ text: 'the page contains:', type: 'outcome', docString: { content: 'a\nb' } })).toBeUndefined();
    const form = ezFallback({ text: 'I fill in the form:', type: 'action', dataTable: [['field', 'value'], ['Username', 'bob'], ['Password', 'x"y']] })!;
    expect(form.rule).toBe('fill-table');
    expect(form.lines).toEqual(['Type "bob" into the "Username" field', 'Type \'x"y\' into the "Password" field']);
    expect(form.steps.map((s) => s.action)).toEqual(['fill', 'fill']);
    expect(ezFallback({ text: 'I click the "Save" button', type: 'action', dataTable: [['a']] })).toBeUndefined();
  });
});

describe('features as journeys', () => {
  const FEATURE = `@shop
Feature: Orders
  Background:
    Given I am on "/login"

  @smoke @req:REQ-7 @risk:5
  Scenario: Place an order
    When I click the "Order" button

  Scenario Outline: Order <qty> items
    When I order <qty> items
    Examples:
      | qty |
      | 1   |
      | 2   |
    @big
    Examples:
      | qty |
      | 99  |

  Rule: Refunds
    @id:refund-flow
    Scenario: Refund
      Then a refund for "<none>" is shown

  Scenario Outline: From a sheet
    Given a customer "<name>"
    Examples: from data "customers.xlsx" sheet "Gold" where tier = "gold"
`;
  const js = featureJourneys(FEATURE, '/p/features/shop/orders.feature', { cwd: '/p', glue: ['/p/steps/a.steps.ts'] });

  it('one journey per scenario and per Examples row, with stable ids and names', () => {
    expect(js.map((j) => j.id)).toEqual([
      'shop-orders--place-an-order', 'shop-orders--order-qty-items-1', 'shop-orders--order-qty-items-2', 'shop-orders--order-qty-items-3', 'refund-flow', 'shop-orders--from-a-sheet',
    ]);
    expect(js.map((j) => j.name)).toEqual(['Place an order', 'Order 1 items', 'Order 2 items', 'Order 99 items', 'Refund', 'From a sheet']);
  });

  it('tags, requirements, risk, variables, external Examples and the bdd meta', () => {
    const [place, row1, , big, refund, sheet] = js;
    expect(place.tags).toEqual(['shop', 'smoke', 'req:REQ-7', 'risk:5']);
    expect(place.requirements).toEqual(['REQ-7']);
    expect(place.risk).toBe(5);
    expect(big.tags).toEqual(['shop', 'big']);
    expect(row1.variables).toEqual({ qty: '1' });
    expect(row1.bdd?.examples).toMatchObject({ index: 0, row: { index: 0, line: 14 } });
    expect(big.bdd?.examples).toMatchObject({ index: 1, row: { index: 0, line: 19 } });
    expect(refund.bdd?.rule?.name).toBe('Refunds');
    expect(sheet.examplesFrom).toEqual({ from: 'customers.xlsx', sheet: 'Gold', where: 'tier = "gold"' });
    expect(sheet.steps[1].intent).toBe('Given a customer "<name>"');
    expect(place.bdd).toMatchObject({ uri: '/p/features/shop/orders.feature', feature: { name: 'Orders', line: 2 }, scenario: { name: 'Place an order', line: 7 }, glue: ['/p/steps/a.steps.ts'], fallback: true });
    expect(place.code).toEqual({ file: '/p/features/shop/orders.feature', name: 'Place an order', line: 7 });
  });

  it('steps are Gherkin steps with their lines (background first)', () => {
    const [place, row1] = js;
    expect(place.steps.map((s) => [s.id, s.intent, s.action, s.handler])).toEqual([
      ['L4', 'Given I am on "/login"', 'code', 'bdd'],
      ['L8', 'When I click the "Order" button', 'code', 'bdd'],
    ]);
    expect(place.steps[0].args).toEqual({ keyword: 'Given', type: 'context', background: true });
    expect(place.steps[1].source).toEqual({ file: '/p/features/shop/orders.feature', line: 8, column: 5 });
    expect(row1.steps[1].value).toBe('I order 1 items');
  });
});
