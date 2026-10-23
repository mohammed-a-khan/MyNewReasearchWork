import { describe, expect, it } from '../support/testkit.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEzScript } from '../../src/intent/index.js';
import { byCandidate, detectSeleniumLanguage, importSelenium } from '../../src/importers/index.js';

const fx = (n: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)), 'utf8');
const body = (ez: string) => ez.split('\n').filter((l) => l && (!l.startsWith('#') || l.startsWith('# TODO')) && !/^(?:Journey|Tags|Id):/.test(l));

describe('Selenium importer', () => {
  it('Java (JUnit 5): setup steps, By locators, Select, waits, assertions and TODOs', () => {
    const r = importSelenium(fx('LoginTest.java'), { file: 'LoginTest.java' });
    expect(r.converted.map((c) => [c.name, c.line])).toEqual([['login as bob', 22], ['create order', 34]]);
    expect(body(r.converted[0].ez)).toEqual([
      'Open "http://localhost:4600/login"',
      'Type "bob" into the field with id "username"',
      'Clear [name="password"]',
      'Type "Builder#2" into [name="password"]',
      'Press Enter in [name="password"]',
      '  Expect the URL contains "/dashboard"',
      `  Expect [data-testid='welcome-user'] has text "bob"`,
      '  Expect the title contains "Dashboard"',
    ]);
    expect(r.converted[0].ez).toContain('Tags: @smoke');
    expect(body(r.converted[1].ez)).toEqual([
      'Open "http://localhost:4600/login"',
      'Click the "New order" link',
      'Select "Gadget (49.50)" from the dropdown with id "product"',
      '# TODO (not converted): customer.selectByIndex(2)',
      "Click //button[@type='submit']",
      'Wait 500 ms',
      '  Expect .toast is visible',
      'Capture the text of [data-testid=order-number] as orderNo',
      '# TODO (not converted): for (int i = 0; i < 3; i++) { System.out.println(i); }',
      '# TODO (not converted): ((JavascriptExecutor) driver).executeScript("window.scrollTo(0, 0)")',
    ]);
    const j = r.journeys[0];
    expect(j.steps[1].target!.locators).toEqual([{ strategy: 'css', value: '#username' }]);
    expect(j.steps[2].target!.locators).toEqual([{ strategy: 'css', value: '[name="password"]' }]);
    expect(r.todo.map((t) => t.line)).toEqual([39, 44, 45]);
    expect(r.warnings.some((w) => w.includes('ignored test-infrastructure statement: driver = new ChromeDriver()'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('tearDown not imported'))).toBe(true);
    for (const c of r.converted) expect(parseEzScript(c.ez)).toEqual(c.journey);
  });

  it('Python (unittest): send_keys with Keys, EC waits, assert statements and assertIn/assertEqual', () => {
    const r = importSelenium(fx('test_checkout.py'), { file: 'test_checkout.py' });
    expect(r.converted).toHaveLength(1);
    expect(body(r.converted[0].ez)).toEqual([
      'Open "http://localhost:4600/login"',
      'Type "bob" into the field with id "username"',
      'Type "Builder#2" into the field with id "password"',
      'Press Enter in the field with id "password"',
      '  Expect the URL contains "/dashboard"',
      '  Expect the title contains "Dashboard"',
      'Click the "New order" link',
      'Select "Widget (19.99)" from the dropdown with id "product"',
      'Clear the field with id "qty"',
      'Type "3" into the field with id "qty"',
      "Click //button[text()='Submit order']",
      'Wait 1000 ms',
      '  Expect the page contains "created"',
      '  Expect [data-testid=order-total] has text "59.97"',
      '  Expect the element with id "download-invoice" is visible',
      '# TODO (not converted): with open("x.txt") as f: f.write("done")',
    ]);
    expect(r.coverage).toEqual({ sourceSteps: 11, convertedSteps: 10, assertions: 5, convertedAssertions: 5 });
  });

  it('C# (NUnit): Navigate().GoToUrl, Url assignment, SelectElement, Assert.That and categories', () => {
    const r = importSelenium(fx('SearchTests.cs'), { file: 'SearchTests.cs' });
    expect(r.converted[0].name).toBe('sign in shows dashboard');
    expect(r.converted[0].ez).toContain('Tags: @smoke');
    expect(body(r.converted[0].ez)).toEqual([
      'Open "http://localhost:4600/login"',
      'Type "bob" into the field with id "username"',
      'Type "Builder#2" into the field with id "password"',
      'Click button[type=submit]',
      '  Expect the URL contains "/dashboard"',
      '  Expect [data-testid=welcome-user] has text "bob"',
      'Click the "New order" link',
      'Select "Fabrikam Inc" from the dropdown with id "customer"',
      '  Expect the title contains "New order"',
      '  Expect the field with id "qty" has value "1"',
      'Open "http://localhost:4600/dashboard"',
      '  Expect .err is hidden',
    ]);
    expect(r.todo).toEqual([]);
    expect(r.coverage).toEqual({ sourceSteps: 7, convertedSteps: 7, assertions: 5, convertedAssertions: 5 });
  });

  it('TestNG argument order, AssertJ, unsupported assertions and By helpers', () => {
    const src = `
public class T {
  @Test(groups = {"regression"})
  public void checks() {
    driver.get("/orders");
    Assert.assertEquals(driver.getCurrentUrl(), "http://x/orders");
    assertThat(driver.findElement(By.id("total")).getText()).contains("10");
    assertNotEquals("x", driver.getTitle());
    driver.findElement(By.partialLinkText("Inv")).click();
    driver.findElements(By.tagName("tr")).get(0).click();
  }
}`;
    const r = importSelenium(src, { file: 'T.java' });
    expect(body(r.converted[0].ez)).toEqual([
      'Open "/orders"',
      '  Expect the URL is "http://x/orders"',
      '  Expect the element with id "total" contains "10"',
      '# TODO (not converted): assertNotEquals("x", driver.getTitle())',
      'Click css=a:has-text("Inv")',
      '# TODO (not converted): driver.findElements(By.tagName("tr")).get(0).click()',
    ]);
    expect(r.converted[0].ez).toContain('Tags: @regression');
    expect(byCandidate('class name', 'btn primary')).toEqual({ strategy: 'css', value: '.btn.primary' });
    expect(detectSeleniumLanguage('from selenium import webdriver')).toBe('py');
    expect(detectSeleniumLanguage('using OpenQA.Selenium;')).toBe('cs');
  });
});
