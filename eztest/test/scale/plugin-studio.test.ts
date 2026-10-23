import { describe, expect, it } from '../support/testkit.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startStudio } from '../../src/studio/index.js';
import { loadPlugins } from '../../src/plugins/index.js';
import { pathToFileURL } from 'node:url';
import { tempDir } from '../runner/fixtures.js';

describe('plugin Studio pages', () => {
  it('lists plugin pages and serves them with a script-free CSP (token required)', async () => {
    const dir = await tempDir('plugin-studio');
    const src = pathToFileURL(join(process.cwd(), 'src', 'plugins', 'index.ts')).href;
    await writeFile(join(dir, 'p.mjs'), `import { definePlugin } from ${JSON.stringify(src)};
export default definePlugin({ name: 'acme-pages', apiVersion: 1, setup(api) {
  api.registerStudioPage({ id: 'sap-status', title: 'SAP status', render: () => '<h1>SAP is up</h1>' });
} });`);
    const plugins = await loadPlugins(['./p.mjs'], { cwd: dir });
    const studio = await startStudio({ cwd: dir, token: 't'.repeat(64), watch: false });
    try {
      const h = { 'x-eztest-token': 't'.repeat(64) };
      expect(await (await fetch(`${studio.origin}/api/plugins/pages`, { headers: h })).json()).toEqual([{ id: 'sap-status', title: 'SAP status' }]);
      const page = await fetch(`${studio.origin}/api/plugins/pages/sap-status`, { headers: h });
      expect(await page.text()).toBe('<h1>SAP is up</h1>');
      expect(page.headers.get('content-security-policy')).toMatch(/^default-src 'none'; style-src 'unsafe-inline'/);
      expect((await fetch(`${studio.origin}/api/plugins/pages/sap-status`)).status).toBe(401);
    } finally {
      await studio.close();
      plugins.off();
    }
  });
});
