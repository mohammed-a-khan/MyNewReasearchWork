/** Relative and scoped targets, ordinals and repository references: parsing, false positives and round trips. */
import { describe, expect, it } from '../support/testkit.js';
import YAML from 'yaml';
import { Journey } from '../../src/core/index.js';
import { describeTarget, journeyToEzScript, normalizeJourneyInput, parseCondition, parseEzScript, parseIntent } from '../../src/intent/index.js';

const scopeOf = (d: string) => describeTarget(d).scope;

describe('relative and scoped targets', () => {
  it('parses rows, containers and layout relations into scopes', () => {
    expect(scopeOf('the "Edit" button in the row containing "Acme"')).toEqual([{ relation: 'row', text: 'Acme' }]);
    expect(scopeOf('the "Edit" button in the "Acme" row')).toEqual([{ relation: 'row', text: 'Acme' }]);
    expect(scopeOf('the "Edit" button on the row with "Acme"')).toEqual([{ relation: 'row', text: 'Acme' }]);
    expect(scopeOf('the "Name" field inside the "Billing" section')).toEqual([
      { relation: 'within', anchor: { description: 'the "Billing" section', locators: [{ strategy: 'role', value: 'region', name: 'Billing', exact: true }, { strategy: 'section', value: 'Billing', exact: true }] } },
    ]);
    expect(scopeOf('the "OK" button in the "Confirm" dialog')?.[0].anchor?.locators[0]).toEqual({ strategy: 'role', value: 'dialog', name: 'Confirm', exact: true });
    expect(scopeOf('the "Delete" button inside #orders')?.[0].anchor?.locators).toEqual([{ strategy: 'css', value: '#orders' }]);
    for (const [phrase, relation] of [
      ['the field below "Email"', 'below'], ['the field under "Email"', 'below'], ['the field above "Email"', 'above'],
      ['the input right of the "Qty" label', 'rightOf'], ['the input to the right of "Qty"', 'rightOf'], ['the field on the left of "Qty"', 'leftOf'],
      ['the "Recalculate" button near "Total"', 'near'], ['the "Go" button next to "Search"', 'near'], ['the "Go" button beside "Search"', 'near'],
    ] as const) {
      expect(scopeOf(phrase)?.[0].relation, phrase).toBe(relation);
    }
    expect(scopeOf('the "Go" button within 20px of "Search"')?.[0]).toMatchObject({ relation: 'near', maxDistance: 20 });
  });

  it('applies the outermost scope first (the last phrase), and anchors can be selectors or repository elements', () => {
    const t = describeTarget('the field below "Email" inside the "Billing" section');
    expect(t.scope?.map((s) => s.relation)).toEqual(['within', 'below']);
    expect(t.locators).toHaveLength(1);
    expect(describeTarget('the field below #email-label').scope?.[0].anchor?.locators).toEqual([{ strategy: 'css', value: '#email-label' }]);
    expect(describeTarget('the "Edit" button near @Orders.title').scope?.[0].anchor).toMatchObject({ element: 'Orders.title' });
  });

  it('parses ordinals without stealing ordinary names', () => {
    expect(describeTarget('the 2nd "Delete" button')).toMatchObject({ nth: 1, locators: [{ strategy: 'role', value: 'button', name: 'Delete' }, expect.anything()] });
    expect(describeTarget('the third "Delete" button').nth).toBe(2);
    expect(describeTarget('the last "Edit" button').nth).toBe(-1);
    expect(describeTarget('the first row').nth).toBe(0);
    expect(describeTarget('the 2nd "Delete" button in the row containing "Acme"')).toMatchObject({ nth: 1, scope: [{ relation: 'row' }] });
    // "first name" and "last name" are labels, not ordinals.
    expect(describeTarget('the first name field')).toMatchObject({ locators: [{ strategy: 'label', value: 'first name' }, expect.anything(), expect.anything()] });
    expect(describeTarget('the Last name field').nth).toBeUndefined();
  });

  it('leaves descriptions without a relation alone', () => {
    for (const d of ['the Sign in button', 'the "Log in" link', 'the Read more below link', 'the Search box', 'the Options', 'testid=in-stock', 'css=div.below > span', '//td[contains(., "Bob")]/..//button']) {
      expect(describeTarget(d).scope, d).toBeUndefined();
    }
    expect(describeTarget('the Sign in button').locators[0]).toEqual({ strategy: 'role', value: 'button', name: 'Sign in', exact: true });
  });

  it('parses repository element references', () => {
    expect(describeTarget('the @Checkout.placeOrder button')).toEqual({ description: 'the @Checkout.placeOrder button', locators: [], element: 'Checkout.placeOrder' });
    expect(describeTarget('@Checkout.placeOrder')).toMatchObject({ element: 'Checkout.placeOrder' });
    expect(describeTarget('the @Orders.edit button in the row containing "Acme"')).toMatchObject({ element: 'Orders.edit', scope: [{ relation: 'row', text: 'Acme' }] });
  });

  it('works in steps and expectations, and plural kinds count', () => {
    expect(parseIntent('Click the "Edit" button in the row containing "Bob"')).toMatchObject({ action: 'click', target: { scope: [{ relation: 'row', text: 'Bob' }] } });
    expect(parseIntent('Type "x" into the field below "Email" inside the "Billing" section')).toMatchObject({ action: 'fill', value: 'x', target: { scope: [{ relation: 'within' }, { relation: 'below' }] } });
    expect(parseCondition('there are 3 "Edit" buttons')).toMatchObject({ type: 'count', equals: 3, target: { locators: [{ strategy: 'role', value: 'button', name: 'Edit' }, expect.anything()] } });
    expect(parseCondition('the "Edit" button in the row containing "Alice" is visible')).toMatchObject({ type: 'visible', target: { scope: [{ relation: 'row', text: 'Alice' }] } });
  });

  it('round-trips through .ez, YAML and JSON', () => {
    const ez = `Journey: Scoped
Open /lab/relative
Click the "Edit" button in the row containing "Bob"
Type "bill@example.com" into the field below "Email" inside the "Billing" section
Click the 2nd "Delete" button
Click the @Checkout.placeOrder button
Expect the "Edit" button in the row containing "Alice" is visible
`;
    const j = parseEzScript(ez);
    const strip = (x: Journey) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'source' ? undefined : v)));
    expect(strip(parseEzScript(journeyToEzScript(j)))).toEqual(strip(j));
    expect(normalizeJourneyInput(JSON.parse(JSON.stringify(j)))).toEqual(j);
    expect(normalizeJourneyInput(YAML.parse(YAML.stringify(JSON.parse(JSON.stringify(j)))))).toEqual(j);
    // A structured scope validates in the Journey schema.
    expect(Journey.safeParse(j).success).toBe(true);
  });
});
