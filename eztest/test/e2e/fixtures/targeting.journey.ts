/** Relative targets, the browser clock and screen element ids from code (demo app /lab pages). Synthetic. */
import { journey, expect, clock, screen, within, inRow, below, rightOf, near, nth } from 'eztest/sdk';

const Relative = screen('Relative', {
  billing: { role: 'region', name: 'Billing', candidates: [{ strategy: 'section', value: 'Billing' }] },
  customers: { role: 'table', name: 'Customers' },
});

journey('Relative targets from code', { id: 'code-relative' }, async ({ ui }) => {
  await ui.open('/lab/relative');
  // Plain English strings use the same parser as .ez.
  await ui.click('the "Edit" button in the row containing "Bob"');
  await expect(await ui.text('#result')).toBe('Editing Bob');
  // Helpers build the same scopes.
  await ui.click(inRow('Acme', 'the "Delete" button'));
  await expect(await ui.text('#result')).toBe('Deleted Acme');
  await ui.fill(within(Relative.billing, below('"Email"', 'the field')), 'code@example.com');
  await expect(await ui.value('#billing-email')).toBe('code@example.com');
  await ui.fill(within('the "Shipping" section', rightOf('the "Qty" text', 'the input')), '4');
  await expect(await ui.value('#shipping-qty')).toBe('4');
  await ui.click(near('"Total"', 'the "Recalculate" button'));
  await expect(await ui.text('#result')).toBe('Recalculated near total');
  await ui.click(nth('the "Edit" button', 0));
  await expect(await ui.text('#result')).toBe('Editing Alice');
  await expect(await ui.count(within(Relative.customers, 'the "Delete" button'))).toBe(3);
});

journey('Clock from code', { id: 'code-clock' }, async ({ ui }) => {
  await clock.pauseAt('2026-12-31T23:59:50Z');
  await ui.open('/lab/clock');
  await clock.advance('15 seconds');
  await expect(await ui.text('#year')).toBe('2027');
  const now = await clock.now();
  await expect(now?.toISOString()).toBe('2027-01-01T00:00:05.000Z');
});
