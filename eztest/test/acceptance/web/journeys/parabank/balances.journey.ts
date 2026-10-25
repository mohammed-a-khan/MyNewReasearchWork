/**
 * ParaBank from code: register a fresh customer, open a second account, move money between them, and check that
 * every page agrees: the overview's balances and total before and after, and the activity of each account.
 */
import { expect, journey, step, ui } from '@eztech.com/eztest/sdk';

const money = (s: string) => Number(s.replace(/[^0-9.-]/g, ''));
type Row = Record<string, string>;

journey('ParaBank: balances agree across pages after a transfer', { tags: ['@parabank', '@code'], baseUrl: 'https://parabank.parasoft.com' }, async () => {
  const user = `ez${Date.now().toString(36)}`;
  await step('Register', async () => {
    await ui.open('/parabank/register.htm');
    const form: Array<[string, string]> = [
      ['First Name', 'Grace'], ['Last Name', 'Hopper'], ['Address', '1 Compiler Way'], ['City', 'Arlington'], ['State', 'VA'],
      ['Zip Code', '22201'], ['Phone #', '5550199'], ['SSN', '987-65-4321'], ['Username', user], ['Password', 'Secret#2026'], ['Confirm', 'Secret#2026'],
    ];
    for (const [label, value] of form) await ui.fill(`the ${label} field`, value);
    await ui.click('the "Register" button', { expect: { text: `Welcome ${user}` } });
  });

  // The overview fills its table after the page loads: wait for every account's link.
  const accountsTable = async (accounts: number) => {
    await ui.click('the "Accounts Overview" link', { expect: { text: 'Balance' } });
    await expect.ui.count('css=#accountTable a').toBe(accounts);
    const rows = (await ui.table('#accountTable')) as Row[];
    return rows.filter((r) => /^\d+$/.test((r.Account ?? '').trim()));
  };

  const before = await step('Read the first overview', () => accountsTable(1));
  await expect(before.length, 'accounts of a new customer').toBe(1);
  const first = before[0].Account.trim();
  const opening = money(before[0]['Balance*']);

  const second = await step('Open a savings account funded from the first', async () => {
    await ui.click('the "Open New Account" link');
    await ui.select('#type', 'SAVINGS');
    await ui.select('#fromAccountId', first);
    await ui.click('the "Open New Account" button', { expect: { text: 'Account Opened!' } });
    return (await ui.text('#newAccountId')).trim();
  });

  const afterOpen = await step('Read the overview again', () => accountsTable(2));
  const balance = (rows: Row[], account: string) => money(rows.find((r) => r.Account.trim() === account)!['Balance*']);
  await expect(afterOpen.map((r) => r.Account.trim()).sort()).toEqual([first, second].sort());
  const funded = balance(afterOpen, second);
  await expect(balance(afterOpen, first) + funded, 'money is not created by opening an account').toBeCloseTo(opening, 2);

  await step('Transfer 40.50 back to the first account', async () => {
    await ui.click('the "Transfer Funds" link');
    await ui.fill('#amount', '40.50');
    await ui.select('#fromAccountId', second);
    await ui.select('#toAccountId', first);
    await ui.click('the "Transfer" button', { expect: { text: 'Transfer Complete!' } });
    await expect.ui.page().toContainText(`$40.50 has been transferred from account #${second} to account #${first}`);
  });

  const afterTransfer = await step('And again', () => accountsTable(2));
  await expect(balance(afterTransfer, second), 'savings balance').toBeCloseTo(funded - 40.5, 2);
  await expect(balance(afterTransfer, first), 'checking balance').toBeCloseTo(balance(afterOpen, first) + 40.5, 2);
  const totalRow = (await ui.table('#accountTable')).find((r: Row) => /Total/i.test(r.Account ?? ''))!;
  await expect(money(totalRow['Balance*']), 'the overview total').toBeCloseTo(opening, 2);

  await step('The account page lists the transfer', async () => {
    await ui.click(`the "${second}" link`, { expect: { text: 'Account Details' } });
    await ui.waitFor('the "Funds Transfer Sent" link', 'visible');
    const activity = (await ui.table('#transactionTable')) as Row[];
    const sent = activity.find((r) => /Funds Transfer Sent/.test(r.Transaction ?? ''));
    await expect(sent, 'a "Funds Transfer Sent" row').toBeDefined();
    await expect(money(sent!['Debit (-)'])).toBeCloseTo(40.5, 2);
  });
});
