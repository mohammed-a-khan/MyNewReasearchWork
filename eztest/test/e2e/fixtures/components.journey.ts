/** A code journey driving component widgets through the SDK's ui.component (enterprise example app). Synthetic. */
import { journey, expect } from 'eztest/sdk';

journey('Kendo widgets from code', { id: 'code-components' }, async ({ ui }) => {
  await ui.open('/lib/kendo');
  await ui.component('grid', 'the Orders grid', 'editCell', { where: { Id: 42 }, column: 'Amount', value: 150 });
  const amount = await ui.component<string>('grid', 'the Orders grid', 'readCell', { where: { Id: 42 }, column: 'Amount' });
  await expect(amount).toBe('150.00');
  await ui.component('combobox', 'the City combobox', 'choose', { values: ['Berlin'] });
  await ui.component('tree', 'the Regions tree', 'expand', { path: 'Asia > Japan' });
  await ui.click('css=#open-dialog');
  await ui.component('dialog', 'Edit order', 'expectOpen');
  await ui.component('dialog', 'Edit order', 'close');
  await ui.component('dialog', 'Edit order', 'expectClosed');
});
