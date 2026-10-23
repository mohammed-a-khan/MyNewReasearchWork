/** Code journeys for the runner-level SDK tests (healing, trace, debugger). Synthetic. */
import { journey, step, expect } from 'eztest/sdk';

journey('Bob orders a gadget', { id: 'code-bob-order', tags: ['@heal'] }, async ({ ui, files }) => {
  await step('Sign in', async () => {
    await ui.open('/login');
    await ui.fill('the Username field', 'bob');
    await ui.fill('the Password field', 'Builder#2');
    await ui.click('the "Sign in" button', { expect: { url: '/dashboard' } });
  });
  await step('Create the order', async () => {
    await ui.open('/orders/new');
    await ui.select('the Product dropdown', 'Gadget (49.50)');
    await ui.fill('the Quantity field', '2');
    await ui.click('the "Submit order" button', { expect: 'the page contains "created"' });
  });
  const number = await ui.text('testid=order-number');
  await expect(number).toMatch(/^ORD-\d+$/);
  const invoice = await ui.download('the "Download invoice" link');
  await expect(invoice.filename).toMatch(/\.pdf$/);
  const pdf = await files.readPdf(invoice);
  await expect(pdf.text).toContain(number.replace('ORD-', 'INV-'));
});
