/**
 * Importers never copy plaintext credentials into journeys: passwords typed
 * into fields, Authorization values, API keys and tokens in headers, bodies and
 * query strings, and literals in lines that were not converted become `${NAME}`
 * variables; the import report lists each one with a secret:// hint, and a
 * `vars:` secret reference provides the value at run time (resolved and masked).
 */
import { describe, expect, it } from '../support/testkit.js';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importFiles, writeImported } from '../../src/importers/index.js';
import { loadJourneyFile } from '../../src/intent/index.js';
import { resolveVarSecrets } from '../../src/engine/index.js';
import { tempDir } from '../runner/fixtures.js';

const SECRETS = ['Hunter2-Pass!', 'S3lenium-Pw', 'tok_9f8e7d6c5b4a', 'AK-55667788', 'cs_0011223344', 'Pg-Body-Secret1', 'TopSecret99x'];

async function sources(dir: string): Promise<string[]> {
  await writeFile(join(dir, 'login.spec.ts'), `import { test, expect } from '@playwright/test';
test('admin signs in', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('Hunter2-Pass!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/dashboard/);
});
`);
  await writeFile(join(dir, 'LoginTest.java'), `import org.openqa.selenium.*;
public class LoginTest {
  @Test
  public void signIn() {
    driver.get("http://shop.test/login");
    driver.findElement(By.name("username")).sendKeys("bob");
    driver.findElement(By.name("password")).sendKeys("S3lenium-Pw");
    settings.put("apiPassword", "TopSecret99x");
    driver.findElement(By.id("login")).click();
  }
}
`);
  const collection = {
    info: { _postman_id: 'c1', name: 'Shop API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{
      name: 'Create order',
      request: {
        method: 'POST',
        header: [{ key: 'Authorization', value: 'Bearer tok_9f8e7d6c5b4a' }, { key: 'X-API-Key', value: 'AK-55667788' }, { key: 'Content-Type', value: 'application/json' }],
        url: { raw: 'https://shop.test/api/orders?client_secret=cs_0011223344', host: ['shop', 'test'], path: ['api', 'orders'], query: [{ key: 'client_secret', value: 'cs_0011223344' }] },
        body: { mode: 'raw', raw: '{"sku":"SKU-1","password":"Pg-Body-Secret1"}' },
      },
    }],
  };
  await writeFile(join(dir, 'shop.postman_collection.json'), JSON.stringify(collection));
  return [join(dir, 'login.spec.ts'), join(dir, 'LoginTest.java'), join(dir, 'shop.postman_collection.json')];
}

describe('credentials in imported tests', () => {
  it('no written file contains a source credential; each is a ${NAME} variable listed in the report with a secret:// hint', async () => {
    const dir = await tempDir('import-creds');
    const report = await importFiles(await sources(dir), { cwd: dir });
    // The in-memory report still has the source values (verification replays with them) ...
    expect(JSON.stringify(report.journeys)).toContain('Hunter2-Pass!');
    const out = join(dir, 'journeys');
    const w = await writeImported(report, out);
    // ... but nothing written does.
    for (const f of await readdir(out)) {
      const text = await readFile(join(out, f), 'utf8');
      for (const s of SECRETS) expect(text, `${f} contains ${s}`).not.toContain(s);
    }
    const ez = Object.fromEntries(await Promise.all(w.ezFiles.map(async (f) => [f.replace(/^.*[\\/]/, ''), await readFile(f, 'utf8')] as const)));
    const all = Object.values(ez).join('\n');
    expect(all).toMatch(/Type "\$\{PASSWORD\}" into the "Password" field/);
    expect(all).toMatch(/Type "\$\{PASSWORD_2\}" into /);
    expect(all).toContain('Bearer ${API_TOKEN}');
    expect(all).toContain('${X_API_KEY}');
    expect(all).toContain('${CLIENT_SECRET}');
    expect(all).toMatch(/"password":\s*"\$\{PASSWORD_3\}"/);
    // The rewritten journeys still parse, with the variables in place.
    for (const f of w.ezFiles) await loadJourneyFile(f);

    const json = JSON.parse(await readFile(w.reportJson, 'utf8')) as { credentials: Array<{ variable: string; kind: string; hint: string; journeyId: string }> };
    const vars = [...new Set(json.credentials.map((c) => c.variable))].sort();
    expect(vars).toEqual(['API_PASSWORD', 'API_TOKEN', 'CLIENT_SECRET', 'PASSWORD', 'PASSWORD_2', 'PASSWORD_3', 'X_API_KEY']);
    expect(json.credentials.find((c) => c.variable === 'API_PASSWORD')!.kind).toBe('source-text'); // from a line that was not converted
    for (const c of json.credentials) expect(c.hint).toContain(`secret://env/${c.variable}`);
    const md = await readFile(w.reportMd, 'utf8');
    expect(md).toContain('## Credentials replaced by variables');
    expect(md).toContain('  PASSWORD: secret://env/PASSWORD');
    for (const s of SECRETS) expect(md).not.toContain(s);
  });

  it('a journey that uses no credential is written unchanged and the report has no credentials section', async () => {
    const dir = await tempDir('import-nocreds');
    await writeFile(join(dir, 'home.spec.ts'), `import { test, expect } from '@playwright/test';
test('home', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Search').fill('gadget');
  await expect(page.getByText('Gadget')).toBeVisible();
});
`);
    const report = await importFiles([join(dir, 'home.spec.ts')], { cwd: dir });
    const w = await writeImported(report, join(dir, 'out'));
    expect(await readFile(w.ezFiles[0], 'utf8')).toBe(report.converted[0].ez);
    expect(JSON.parse(await readFile(w.reportJson, 'utf8')).credentials).toBeUndefined();
    expect(await readFile(w.reportMd, 'utf8')).not.toContain('Credentials replaced');
  });

  it('vars: { NAME: secret://env/NAME } provides the value at run time, resolved and masked', async () => {
    const masked: string[] = [];
    const vars = await resolveVarSecrets({ PASSWORD: 'secret://env/PASSWORD', PLAIN: 'x' }, async (ref) => (ref === 'secret://env/PASSWORD' ? 'from-the-store' : ''), (v) => masked.push(v));
    expect(vars).toEqual({ PASSWORD: 'from-the-store', PLAIN: 'x' });
    expect(masked).toEqual(['from-the-store']);
    await expect(resolveVarSecrets({ PASSWORD: 'secret://env/NOPE' }, async () => { throw new Error('not found'); }, () => undefined)).rejects.toThrow(/vars\.PASSWORD: secret:\/\/env\/NOPE could not be resolved: not found/);
  });
});
