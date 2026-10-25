/**
 * "Watch for toasts" keeps watching after a full-page navigation (real browser through runJourneys).
 *
 * OrangeHRM's Add Employee: "Successfully Saved", then a new document (Personal Details) where saving shows
 * "Successfully Updated" for a moment. The watcher of the new document is started by an init script before the
 * document has an element to observe; it failed there, but had already marked itself as running, so neither it
 * nor a second "Watch for toasts" recorded anything on that page: only the toast from before the navigation was
 * listed.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';

/** A toast that shows for `ms` milliseconds, `after` ms after the call (as an app shows it once its PUT returns). */
const TOAST = `function toast(text, after, ms) {
  setTimeout(function () {
    var t = document.createElement('div'); t.className = 'oxd-toast'; t.setAttribute('role', 'alert'); t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms);
  }, after);
}`;

const ADD = `<!doctype html><html><head><title>Add Employee</title></head><body><h1>Add Employee</h1>
<button id="save">Save</button>
<script>${TOAST}
document.getElementById('save').addEventListener('click', function () {
  toast('Successfully Saved', 0, 2000);
  setTimeout(function () { location.href = '/details'; }, 80);
});
</script></body></html>`;

const DETAILS = `<!doctype html><html><head><title>Personal Details</title></head><body><h1>Personal Details</h1>
<section><h2>Personal Details</h2><button id="update">Save</button></section>
<script>${TOAST}
document.getElementById('update').addEventListener('click', function () { toast('Successfully Updated', 200, 150); });
</script></body></html>`;

let server: Server;
let base = '';
let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eztest-toasts-nav-'));
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(u.pathname === '/details' ? DETAILS : ADD);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

describe('Watch for toasts across a full-page navigation', () => {
  it('records the toast of the new document, gone before it is checked', async () => {
    const journey = parseEzScript([
      'Journey: Toasts before and after the navigation',
      '',
      'Open /',
      'Watch for toasts',
      'Click the "Save" button',
      'Expect a toast containing "Successfully Saved"',
      'Expect the URL contains "/details"',
      'Expect the page contains "Personal Details"',
      'Click the "Save" button in the "Personal Details" section',
      'Wait 1 second',
      'Expect a toast containing "Successfully Updated"',
      '',
    ].join('\n'));
    const run = await runJourneys([journey], { outputDir: join(dir, 'out'), baseUrl: base, stepTimeoutMs: 8000 });
    const j = run.journeys[0];
    expect(j.steps.filter((s) => s.status !== 'passed').map((s) => `${s.intent}: ${s.error?.message}`)).toEqual([]);
  }, 120_000);
});
