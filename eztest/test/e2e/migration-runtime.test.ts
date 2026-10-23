/**
 * Runtime capabilities migrating teams rely on: downloads read as rows and compared with a
 * named query, the global loader wait (and its overhead), video/trace retention on
 * failure, mustache payload templates, and the browser channel option.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { chromium } from '../../src/browser/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { launchOptions, runJourneys, waitForLoaders, settleLoaders, type RunOptions, type StepContext } from '../../src/runner/index.js';
import { DbRegistry } from '../../src/surfaces/index.js';
import { describeSteps, FAST } from './advanced-helpers.js';

let server: Server;
let base: string;
let dir: string;
let dbs: DbRegistry;
const echo: unknown[] = [];

const PAGE = `<!doctype html><html><head><title>Exports</title></head><body>
<h1>Invoice</h1>
<p><a href="/files/invoice.csv" download>Export CSV</a> <a href="/files/invoice.xlsx" download>Export XLSX</a></p>
<p><button id="load" onclick="var s=document.createElement('div');s.className='spinner';s.textContent='Loading...';document.body.appendChild(s);setTimeout(function(){s.remove();document.getElementById('out').textContent='Loaded 3 rows';},700)">Load</button></p>
<p id="out"></p>
</body></html>`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eztest-migration-rt-'));
  const dbFile = join(dir, 'shop.db');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE invoice_lines (Id INTEGER PRIMARY KEY, Sku TEXT, Amount REAL, Note TEXT)');
  for (const [id, sku, amt, note] of [[1, 'SKU-1', 10, 'db note'], [2, 'SKU-2', 25.5, 'x'], [3, 'SKU-3', 3.25, 'y']] as const) {
    db.prepare('INSERT INTO invoice_lines VALUES (?, ?, ?, ?)').run(id, sku, amt, note);
  }
  db.close();
  mkdirSync(join(dir, 'queries'));
  writeFileSync(join(dir, 'queries', 'INVOICE_LINES.sql'), '-- INVOICE_LINES\nSELECT Id, Sku, Amount, Note\nFROM invoice_lines\nORDER BY Id\n');
  writeFileSync(join(dir, 'queries', 'INVOICE_LINE_BY_SKU.sql'), 'SELECT Id, Sku, Amount, Note FROM invoice_lines WHERE Sku = ?\n');
  writeFileSync(join(dir, 'payload.json'), '{"codes": {{json(codes)}}, "name": "{{name}}", "due": "{{addBusinessDays("2026-10-23", 1)}}"}');
  dbs = new DbRegistry({ demo: { driver: 'sqlite', file: dbFile } });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Lines');
  ws.addRow(['Id', 'Sku', 'Amount', 'Note']);
  ws.addRow([1, 'SKU-1', 10, 'sheet']);
  ws.addRow([2, 'SKU-2', 25.5, 'sheet']);
  ws.addRow([3, 'SKU-3', 3.25, 'sheet']);
  const xlsx = Buffer.from(await wb.xlsx.writeBuffer());

  server = createServer(async (req, res) => {
    if (req.url === '/files/invoice.csv') {
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="invoice.csv"' });
      res.end('ID;SKU;AMOUNT;NOTE\n1;SKU-1;10.004;from csv\n2;SKU-2;25.5;"semi;colon"\n3;SKU-3;3.25;z\n');
    } else if (req.url === '/files/invoice.xlsx') {
      res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': 'attachment; filename="invoice.xlsx"' });
      res.end(xlsx);
    } else if (req.url === '/api/echo' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      echo.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await dbs?.closeAll();
  await new Promise<void>((r) => server?.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const db: RunOptions['db'] = {
  query: async (c, sql, params) => (await dbs.get(c)).query(sql, params ?? []),
  dialect: async (c) => (await dbs.get(c)).dialect,
};
const run = (ez: string, o: Partial<RunOptions> = {}) =>
  runJourneys([parseEzScript(ez)], { ...FAST, baseUrl: base, outputDir: join(dir, 'out'), db, baseDir: dir, queriesDir: join(dir, 'queries'), ...o });

describe('downloads as data', () => {
  it('reads CSV and XLSX downloads as rows and compares them with a named query', async () => {
    const r = await run([
      'Journey: Downloads as rows',
      'Open /',
      'Download the "Export CSV" link as export',
      'Read the download export as rows into lines',
      'Expect rows lines equal query "INVOICE_LINES" on demo by key "Id" ignoring columns "Note" with tolerance 0.01',
      'Download the "Export XLSX" link as xl',
      'Read the download xl sheet "Lines" as rows into sheet',
      'Expect rows sheet equal query "INVOICE_LINES" on demo by key "Id" ignoring columns "Note"',
      'Expect rows sheet equal rows lines by key "Id" ignoring columns "Note" with tolerance 0.01',
      'Expect len(lines) == 3',
      '',
    ].join('\n'));
    const j = r.journeys[0];
    expect(j.status, describeSteps(j)).toBe('passed');
    const exp = j.ledger.export as { path: string };
    expect(exp.path.startsWith(join(dir, 'out', r.runId))).toBe(true); // saved in the run directory, never ~/Downloads
    expect((j.ledger.lines as Array<Record<string, string>>)[1]).toEqual({ ID: '2', SKU: 'SKU-2', AMOUNT: '25.5', NOTE: 'semi;colon' });
  }, 60_000);

  it('fails with the differing cells when the rows do not match', async () => {
    const r = await run([
      'Journey: Downloads mismatch',
      'Open /',
      'Download the "Export CSV" link as export',
      'Read the download export as rows into lines',
      'Expect rows lines equal query "INVOICE_LINES" on demo by key "Id"',
      '',
    ].join('\n'));
    const step = r.journeys[0].steps.at(-1)!;
    expect(step.status).toBe('failed');
    expect(step.error?.message).toMatch(/Data comparison failed/);
    const missing = await run('Journey: Missing query\nOpen /\nDownload the "Export CSV" link as e\nRead the download e as rows into l\nExpect rows l equal query "NOPE" on demo by key "Id"\n');
    expect(missing.journeys[0].steps.at(-1)?.error?.message).toMatch(/Named query "NOPE" not found/);
  }, 60_000);
});

describe('global loader wait', () => {
  const ez = 'Journey: Spinner\nOpen /\nClick the Load button\nExpect the page contains "Loaded 3 rows"\n';

  it('waits for configured loaders before post-conditions (and the journey header adds loaders)', async () => {
    const without = await run(ez, { conditionTimeoutMs: 150 });
    expect(without.journeys[0].status).toBe('failed');
    const withLoaders = await run(ez, { conditionTimeoutMs: 150, loaders: { selectors: ['.spinner'], timeoutMs: 5000 } });
    expect(withLoaders.journeys[0].status, describeSteps(withLoaders.journeys[0])).toBe('passed');
    const header = await run(ez.replace('Journey: Spinner\n', 'Journey: Spinner header\nLoaders: ".spinner"\n'), { conditionTimeoutMs: 150 });
    expect(header.journeys[0].status, describeSteps(header.journeys[0])).toBe('passed');
    const phrase = await run('Journey: Explicit\nOpen /\nClick the Load button\nWait for loaders to disappear\nExpect the page contains "Loaded 3 rows"\n', { conditionTimeoutMs: 150 });
    expect(phrase.journeys[0].status, describeSteps(phrase.journeys[0])).toBe('passed');
  }, 60_000);

  it('costs nothing without loaders and little with them', async () => {
    // No loaders configured: never touches the page.
    const noPage = new Proxy({}, { get: () => { throw new Error('page touched'); } });
    const ctx = { page: noPage, journey: { loaders: undefined }, logger: { warn: () => undefined } } as unknown as StepContext;
    const step = parseEzScript('Journey: x\nClick the Load button\n').steps[0];
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) await settleLoaders(step, ctx, { outputDir: '.' });
    const perStepNoLoaders = (performance.now() - t0) / 10_000;
    expect(perStepNoLoaders).toBeLessThan(0.05);
    // Loaders configured, none visible: one page evaluation per check.
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(base);
      const n = 50;
      const t1 = performance.now();
      for (let i = 0; i < n; i++) expect((await waitForLoaders(page, ['.spinner', '.loading', '[aria-busy="true"]', 'xpath=//div[@class="overlay"]'], 1000)).checks).toBe(1);
      const perCheck = (performance.now() - t1) / n;
      expect(perCheck).toBeLessThan(50);
      console.log(`loader wait overhead: ${perStepNoLoaders.toFixed(5)} ms/step without loaders, ${perCheck.toFixed(2)} ms/check with 4 selectors and none visible`);
      await page.click('#load');
      const r = await waitForLoaders(page, ['.spinner'], 5000);
      expect(r.capped).toBe(false);
      expect(r.waitedMs).toBeGreaterThan(300);
      await page.click('#load');
      expect((await waitForLoaders(page, ['.spinner'], 200)).capped).toBe(true);
    } finally {
      await browser.close();
    }
  }, 60_000);
});

describe('execution settings parity', () => {
  it('keeps video and trace only for attempts that did not pass (retain-on-failure / on-failure)', async () => {
    const out = join(dir, 'parity');
    const failed = await runJourneys([parseEzScript('Journey: Will fail\nOpen /\nExpect the page contains "Not there"\n')], {
      ...FAST, conditionTimeoutMs: 200, baseUrl: base, outputDir: out, video: 'retain-on-failure', traceMode: 'on-failure', screenshots: 'before-assertions',
    });
    const runDir = join(out, failed.runId);
    const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
    const all = files(runDir);
    expect(all.some((f) => f.endsWith('.webm'))).toBe(true);
    expect(all.some((f) => /traces\/.*\.zip$/.test(f))).toBe(true);
    expect(all.some((f) => f.endsWith('.before-assert.png'))).toBe(true);
    expect(failed.journeys[0].evidence.length).toBeGreaterThan(3);
    const passed = await runJourneys([parseEzScript('Journey: Will pass\nOpen /\nExpect the page contains "Invoice"\n')], {
      ...FAST, baseUrl: base, outputDir: out, video: 'retain-on-failure', traceMode: 'on-failure',
    });
    expect(existsSync(join(out, passed.runId, 'videos'))).toBe(false);
    expect(existsSync(join(out, passed.runId, 'traces'))).toBe(false);
  }, 60_000);

  it('passes the browser channel to the driver (chromium only)', () => {
    expect(launchOptions({ outputDir: '.', channel: 'msedge' })).toEqual({ headless: true, channel: 'msedge' });
    expect(launchOptions({ outputDir: '.', channel: 'chromium', headless: false })).toEqual({ headless: false });
    expect(() => launchOptions({ outputDir: '.', browser: 'firefox', channel: 'msedge' })).toThrow(/channels are for chromium/);
  });
});

describe('payload templates', () => {
  it('renders {{json(x)}} / {{var}} in body files with templates.syntax mustache', async () => {
    const ez = 'Journey: Payload\nVariables: name="O\'Neil"\nSet variable codes to ["A", "B"]\nCall API "POST /api/echo" with body from file "payload.json" and store as echo\nExpect len(echo.body.codes) == 2\n';
    const r = await run(ez, { templateSyntax: 'mustache' });
    expect(r.journeys[0].status, describeSteps(r.journeys[0])).toBe('passed');
    expect(echo.at(-1)).toEqual({ codes: ['A', 'B'], name: "O'Neil", due: '2026-10-26' });
  }, 60_000);
});
