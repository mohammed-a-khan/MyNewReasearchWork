/**
 * The standalone demo app (`npm run demo`) and the example projects use one
 * database file: shop-project's and bdd-project's `db.connections.shop`
 * default to the file the demo writes, so their database steps see its tables
 * (they used to open an empty ./shop.db and fail with "no such table").
 */
import { afterAll, describe, expect, it } from '../support/testkit.js';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from '../../src/config/index.js';
import { DbRegistry } from '../../src/surfaces/index.js';
import { demoDbFile, startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { tempDir } from '../runner/fixtures.js';

const EXAMPLES = resolve(__dirname, '../../examples');
let app: DemoServer | undefined;
afterAll(async () => app?.close());

describe('demo app database', () => {
  it('shop-project and bdd-project default to the database file the standalone demo app uses', async () => {
    expect(demoDbFile({})).toBe(join(EXAMPLES, 'demo-app', 'shop.db'));
    expect(demoDbFile({ DEMO_DB: '/tmp/x.db' })).toBe('/tmp/x.db');
    for (const p of ['shop-project', 'bdd-project']) {
      const cwd = join(EXAMPLES, p);
      const env: Record<string, string | undefined> = { ...process.env };
      delete env.SHOP_DB;
      const loaded = await loadConfig({ cwd, environment: env });
      const shop = loaded.config.db.connections.shop as { driver: string; file: string };
      expect(shop.driver).toBe('sqlite');
      expect(resolve(cwd, shop.file), p).toBe(demoDbFile({}));
    }
  });

  it('a database step of the example project sees the tables the demo app created in that file', async () => {
    const dir = await tempDir('demo-db');
    const file = join(dir, 'shop.db');
    app = await startDemoApp({ dbFile: file });
    const loaded = await loadConfig({ cwd: join(EXAMPLES, 'shop-project'), environment: { ...process.env, SHOP_DB: file } });
    const dbs = new DbRegistry(loaded.config.db.connections as never);
    try {
      const rows = await (await dbs.get('shop')).query('SELECT name FROM customers ORDER BY id');
      expect(rows.map((r) => r.name)).toEqual(['Contoso Ltd', 'Fabrikam Inc', 'Northwind Traders']);
    } finally {
      await dbs.closeAll();
      await app.close();
      app = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
