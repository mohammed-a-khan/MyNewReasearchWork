/**
 * The widgets of real UI kits, recorded the way a person uses them (mouse and keyboard) and replayed:
 *  - labels next to their fields, linked to nothing (`<label>Username</label><div><input></div>`),
 *  - a custom select: a focusable box that opens a listbox on mousedown, re-renders itself while opening, and takes
 *    the pick on the option's mousedown (so the option's click never arrives),
 *  - an autocomplete that writes the full picked text into its field, with two identical suggestions,
 *  - a loading overlay over a form that is gone a moment later,
 *  - a new record's id in the URL after Save.
 * The same behaviours were seen on a real HR product (test/acceptance runs against it); this page is our own.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '../../src/browser/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { startRecording, type RecordingResult } from '../../src/recorder/index.js';
import { runJourneys } from '../../src/runner/index.js';

const KIT = `
<style>
  .group { margin: 12px 0; } .box { border: 1px solid #888; padding: 6px; width: 220px; cursor: pointer; }
  [role=listbox] { border: 1px solid #444; width: 230px; } [role=option] { padding: 4px; }
  .loader { position: fixed; inset: 0; background: rgba(255,255,255,.8); }
</style>
<script>
  // A custom select: <div class="select"><div class="box" tabindex="0">-- Select --</div></div>
  function customSelect(wrap, options) {
    let open = false;
    const render = (text) => {
      const old = wrap.querySelector('.box');
      const box = document.createElement('div'); // re-rendered while opening, as virtual-DOM kits do
      box.className = 'box'; box.tabIndex = 0; box.textContent = text;
      box.addEventListener('mousedown', toggle);
      old ? old.replaceWith(box) : wrap.prepend(box);
    };
    const close = () => { open = false; wrap.querySelector('[role=listbox]')?.remove(); };
    function toggle(e) {
      e.preventDefault();
      if (open) return close();
      open = true;
      render(wrap.querySelector('.box').textContent);
      const list = document.createElement('div'); list.setAttribute('role', 'listbox');
      for (const o of options) {
        const opt = document.createElement('div'); opt.setAttribute('role', 'option'); opt.innerHTML = '<span>' + o + '</span>';
        opt.addEventListener('mousedown', (ev) => { ev.preventDefault(); close(); render(o); });
        list.append(opt);
      }
      wrap.append(list);
    }
    render('-- Select --');
  }
  // An autocomplete: suggestions on typing; the pick writes the full text into the field.
  function autocomplete(input, names) {
    const wrap = input.parentElement;
    input.addEventListener('input', () => {
      wrap.querySelector('[role=listbox]')?.remove();
      const q = input.value.toLowerCase(); if (!q) return;
      const list = document.createElement('div'); list.setAttribute('role', 'listbox');
      for (const n of names.filter((x) => x.toLowerCase().includes(q))) {
        const opt = document.createElement('div'); opt.setAttribute('role', 'option'); opt.textContent = n;
        opt.addEventListener('mousedown', (ev) => { ev.preventDefault(); list.remove(); input.value = n.replace(' ', '  '); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#picked').textContent = 'Picked ' + n; });
        list.append(opt);
      }
      wrap.append(list);
    });
  }
</script>`;

const FORM = `<!doctype html><title>Kit</title>${KIT}
<h1>New item</h1>
<div class="loader" id="loader"></div>
<form method="post" action="/items">
  <div class="group"><div><label>Item Name</label></div><div><input name="name"></div></div>
  <div class="group"><div><label>Category</label></div><div><div class="select" id="cat"></div></div></div>
  <input type="hidden" name="category" id="catv">
  <div class="group"><div><label>Owner</label></div><div><div class="ac"><input id="owner" placeholder="Type for hints..."></div></div></div>
  <p id="picked"></p>
  <button type="submit">Save</button>
</form>
<script>
  setTimeout(() => document.getElementById('loader').remove(), 700);
  customSelect(document.getElementById('cat'), ['Hardware', 'Software', 'Services']);
  autocomplete(document.getElementById('owner'), ['Ana Lee', 'Ana Lee', 'Bo Chan']);
  document.querySelector('form').addEventListener('submit', () => { document.getElementById('catv').value = document.querySelector('#cat .box').textContent; });
</script>`;

let server: Server;
let site: string;
let result: RecordingResult;
let nextId = 41;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function click(page: Page, el: Locator): Promise<void> {
  await el.waitFor({ timeout: 10_000 });
  const b = (await el.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await pause(250);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.method === 'POST' && path === '/items') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const f = new URLSearchParams(body);
        res.writeHead(303, { location: `/items/${nextId++}/view?name=${encodeURIComponent(f.get('name') ?? '')}&category=${encodeURIComponent(f.get('category') ?? '')}` });
        res.end();
      });
      return;
    }
    const view = /^\/items\/\d+\/view$/.test(path);
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    res.writeHead(path === '/items/new' || view ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(path === '/items/new' ? FORM : view ? `<!doctype html><title>Item</title><h1>Item saved</h1><p>${q.get('name')} in ${q.get('category')}</p>` : 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  site = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;

  const rec = await startRecording({ url: `${site}/items/new`, headless: true, name: 'new item' });
  const p = rec.page;
  // Too quick: the click lands on the loading overlay. Then the person waits for the form.
  await click(p, p.locator('#loader'));
  await pause(900);
  await click(p, p.locator('input[name=name]'));
  await p.keyboard.type('Laptop', { delay: 20 });
  await click(p, p.locator('#cat .box'));
  await click(p, p.getByRole('option', { name: 'Software' }));
  await click(p, p.locator('#owner'));
  await p.keyboard.type('ana', { delay: 20 });
  await click(p, p.getByRole('option', { name: 'Ana Lee' }).first());
  await click(p, p.getByRole('button', { name: 'Save' }));
  await p.waitForURL('**/view**');
  await pause(300);
  await rec.addExpectation('page contains "Laptop in Software"');
  result = await rec.stop();
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('recording custom UI-kit widgets', () => {
  it('records them as plain steps, without CSS paths, overlay clicks or the app filling a field', () => {
    const lines = result.ez.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(lines.slice(lines.indexOf('Open /items/new'))).toEqual([
      'Open /items/new',
      'Type "Laptop" into the Item Name field',
      'Select "Software" from the Category dropdown',
      'Type "ana" into the Owner field',
      'Click the 1st "Ana Lee" option',
      'Click the "Save" button',
      'Expect URL contains "/items/"',
      'Expect page contains "Laptop in Software"',
    ]);
    expect(lines).toContain(`Base URL: ${site}`);
    expect(result.warnings.some((w) => /left out: the element disappeared/.test(w))).toBe(true);
  });

  it('replays green', async () => {
    const run = await runJourneys([parseEzScript(result.ez, { source: 'recorded.ez' })], { outputDir: await mkdtemp(join(tmpdir(), 'ez-widgets-')), headless: true });
    const jr = run.journeys[0];
    expect(jr.steps.filter((s) => s.status === 'failed').map((s) => `${s.intent}: ${s.error?.message ?? ''}`)).toEqual([]);
    expect(jr.status).toBe('passed');
  });

  it('finds a field by a label linked to nothing, and picks from custom selects and autocompletes when hand-written', async () => {
    const ez = `Journey: by hand\nBase URL: ${site}\nOpen /items/new\nType "Desk" into the "Item Name" field\nSelect "Hardware" from the "Category" dropdown\nSelect "Bo Chan" from the "Owner" field\nClick the "Save" button\n  Expect page contains "Desk in Hardware"\n`;
    const run = await runJourneys([parseEzScript(ez, { source: 'hand.ez' })], { outputDir: await mkdtemp(join(tmpdir(), 'ez-widgets-')), headless: true });
    expect(run.journeys[0].steps.filter((s) => s.status === 'failed').map((s) => `${s.intent}: ${s.error?.message ?? ''}`)).toEqual([]);
  });
});
