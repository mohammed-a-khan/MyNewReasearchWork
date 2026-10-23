/** Code steps called from .ez (synthetic fixture). */
import { codeStep, step } from 'eztest/sdk';
import { Dashboard } from '../screens/shop.js';

export const orderTotals = codeStep<{ region: string; minLimit: string }>(async ({ db, ui, vars, expect }, { region, minLimit }) => {
  const rows = await db.query<{ name: string; credit_limit: number }>('CUSTOMERS_BY_REGION', { region });
  const big = rows.filter((r) => r.credit_limit >= Number(minLimit));
  await step('Check the dashboard', async () => {
    await ui.open('/dashboard');
    await expect.ui.visible(Dashboard.welcome);
  });
  vars.set('checkedBy', 'code');
  return { count: big.length, first: big[0]?.name };
});
