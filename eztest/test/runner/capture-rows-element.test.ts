/**
 * `Capture the rows of the @Users.table as uiRows` (an element whose key is `table`, no kind word after it) read
 * the page text: the line was not the rows phrasing, and "the rows of the @Users.table" became a text capture.
 * It reads the rows of the element now (the one table inside it when the element is the area around it), and an
 * element that is not a table fails the step instead of returning nothing. Real browser, element repository.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ElementRepository } from '../../src/elements/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';

/** Temporary folders this file made, removed at the end. */
const made: string[] = [];
async function tempDirOf(prefix: string): Promise<string> {
  const d = await mkdtemp(prefix);
  made.push(d);
  return d;
}
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const PAGE = `<!doctype html><html><head><title>System Users</title></head><body>
<h1>System Users</h1>
<div class="users-card">
  <div role="table" class="oxd-table"><div role="rowgroup"><div role="row"><div role="columnheader">Username</div><div role="columnheader">User Role</div><div role="columnheader">Status</div></div></div>
  <div role="rowgroup"><div role="row"><div role="cell">Admin</div><div role="cell">Admin</div><div role="cell">Enabled</div></div>
  <div role="row"><div role="cell">linus</div><div role="cell">ESS</div><div role="cell">Enabled</div></div></div></div>
</div>
<p class="summary">(2) Records Found</p>
</body></html>`;

let server: Server;
let base = '';
let dir = '';
let elements: ElementRepository;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await tempDirOf(join(tmpdir(), 'ez-rows-element-'));
  await mkdir(join(dir, 'elements'));
  await writeFile(join(dir, 'elements', 'users.yaml'), ['screen: Users', 'elements:', '  table: css=.users-card', '  summary: css=.summary', ''].join('\n'));
  elements = await ElementRepository.load(dir);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe('Capture the rows of an element', () => {
  it('reads the rows of @Users.table (the table inside the element)', async () => {
    const j = parseEzScript('Journey: Users\n\nOpen /\nCapture the rows of the @Users.table as uiRows\n');
    expect(j.steps[1]).toMatchObject({ action: 'query', args: { what: 'table' }, captureAs: 'uiRows' });
    const run = await runJourneys([j], { outputDir: join(dir, 'out'), baseUrl: base, elements, stepTimeoutMs: 5000 });
    const r = run.journeys[0];
    expect(r.status, JSON.stringify(r.steps.map((s) => s.error?.message))).toBe('passed');
    expect(r.ledger.uiRows).toEqual([
      { Username: 'Admin', 'User Role': 'Admin', Status: 'Enabled' },
      { Username: 'linus', 'User Role': 'ESS', Status: 'Enabled' },
    ]);
  }, 60_000);

  it('an element that is not a table fails the step, saying so', async () => {
    const j = parseEzScript('Journey: Not a table\n\nOpen /\nCapture the rows of @Users.summary as rows\n');
    const run = await runJourneys([j], { outputDir: join(dir, 'out2'), baseUrl: base, elements, stepTimeoutMs: 5000 });
    const r = run.journeys[0];
    expect(r.status).toBe('failed');
    expect(r.steps[1].error?.message).toMatch(/is not a table and holds none/);
    expect(r.ledger.rows).toBeUndefined();
  }, 60_000);
});
