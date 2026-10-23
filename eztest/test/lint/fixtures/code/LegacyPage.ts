// A page object in the style of a legacy framework (fixture for eztest lint; never executed).
export class LegacyPage {
  private readonly password = 'Winter2025!';
  private readonly apiKey = process.env.API_KEY;

  async openRecipe(page: any, recipeTitle: string) {
    const safeTitle = recipeTitle.replace(/'/g, "\\'");
    const card = page.locator(`//section[@class='recipes']//li[strong[contains(., '${safeTitle}')]]`);
    await page.waitForTimeout(3000);
    await new Promise((r) => setTimeout(r, 1500));
    await card.click();
    await page.locator('/html/body/div[3]/div/button').click();
    await page.locator("//table[@id='grid']//tr[2]/td[4]").click();
    await page.goto('/orders/new');
  }
}
