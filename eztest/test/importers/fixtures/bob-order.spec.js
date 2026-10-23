// Playwright Test spec used by the importer replay test (never executed directly).
import { test, expect } from '@playwright/test';

const PASSWORD = 'Builder#2';

test.describe('EZ Shop orders', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill('bob');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('bob creates an order @smoke', async ({ page }) => {
    await expect(page.getByTestId('welcome-user')).toHaveText('bob');
    await page.getByRole('link', { name: 'New order' }).first().click();
    await page.goto('/orders/new');
    await expect(page).toHaveTitle(/New order/);
    await page.locator('#customer').selectOption('Northwind Traders');
    await page.getByLabel('Product').selectOption({ label: 'Gadget (49.50)' });
    const qty = page.getByLabel('Quantity');
    await qty.fill('2');
    await expect(qty).toHaveValue('2');
    await page.getByRole('button', { name: 'Submit order' }).click();
    await expect(page.getByRole('status')).toContainText('created');
    await expect(page.getByTestId('order-customer')).toHaveText('Northwind Traders');
    await expect(page.getByTestId('order-total')).toHaveText('99.00');
    await expect(page.getByRole('table', { name: 'Order lines' }).locator('tbody tr')).toHaveCount(1);
    await expect(page.getByText('Download invoice')).toBeVisible();
    await page.screenshot({ path: 'order.png' });
  });
});
