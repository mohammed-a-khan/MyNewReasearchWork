/** Shared helpers for the native BDD tests: a copy of the synthetic shop project with the demo app running. */
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { startDemoApp, type DemoOptions, type DemoServer } from '../../examples/demo-app/server.js';

export { byId, cli, flat, latestRun, tree } from '../sdk/helpers.js';

export const BDD_FIXTURE = resolve(__dirname, 'fixtures/shop');

/** A fresh copy of the BDD shop project (with a generated quotes.xlsx) and the demo app on its own SQLite file. */
export async function bddProject(opts: DemoOptions = {}): Promise<{ project: string; app: DemoServer; env: Record<string, string>; restore(): Promise<void> }> {
  const project = await mkdtemp(join(tmpdir(), 'eztest-bdd-'));
  await cp(BDD_FIXTURE, project, { recursive: true });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Quotes');
  ws.addRow(['sku', 'qty', 'total']);
  ws.addRow(['SKU-100', '5', '99.95']);
  ws.addRow(['SKU-300', '2', '10.50']);
  await wb.xlsx.writeFile(join(project, 'data', 'quotes.xlsx'));
  const app = await startDemoApp({ ...opts, dbFile: join(project, 'shop.db') });
  const env: Record<string, string> = { SHOP_URL: app.url, SHOP_DB: join(project, 'shop.db') };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  return {
    project, app, env,
    async restore() {
      await app.close().catch(() => undefined);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}
