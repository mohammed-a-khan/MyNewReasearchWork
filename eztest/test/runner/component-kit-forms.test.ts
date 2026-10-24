/**
 * Forms the way Vue/React component kits render them (OrangeHRM's oxd as the model), in a real browser through
 * runJourneys: labels that sit next to their field, an upload behind a picture (with a second picture of the
 * same name elsewhere), a custom radio button drawn over its hidden input, a toast shown just before the page
 * navigates, a div-based ARIA table, journey variables that refer to run variables, and one-time codes.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { resolveVariableRefs } from '../../src/core/index.js';
import { freshTotp, generateTotp, totpCounter } from '../../src/identity/totp.js';
import { parseEzScript, parseIntent } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';

const FORM = `<!doctype html><html><head><title>Add Employee</title><style>
.hidden-file{display:none}.radio label{position:relative;padding-left:24px}.radio input{opacity:0;position:absolute;left:0;top:0;width:16px;height:16px;margin:0}
.radio span{position:absolute;left:0;top:0;width:16px;height:16px;border:1px solid #333;border-radius:50%}.toast{position:fixed;bottom:10px}</style></head>
<body><header><img alt="profile picture" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20"> Admin</header>
<form id="f">
  <div class="group"><div class="pic"><input type="file" class="hidden-file" id="photo"><img alt="profile picture" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="60" height="60"><button type="button">+</button></div></div>
  <div class="group"><div><label>Employee Full Name</label></div><div><input placeholder="First Name" name="first"><input placeholder="Last Name" name="last"></div></div>
  <div class="group"><div class="label-wrapper"><label>Employee Id</label></div><div><input name="empId"></div></div>
  <div class="group"><div><label>Gender</label></div><div class="radio"><label><input type="radio" name="g" value="1"><span></span>Male</label><label><input type="radio" name="g" value="2"><span></span>Female</label></div></div>
  <button type="submit">Save</button>
</form>
<script>
document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault();
  var f = new FormData(this);
  var t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = 'Successfully Saved';
  document.body.appendChild(t);
  var q = new URLSearchParams({ first: f.get('first'), last: f.get('last'), id: f.get('empId'), g: f.get('g') || '', photo: (document.getElementById('photo').files[0] || {}).name || '' });
  setTimeout(function () { location.href = '/saved?' + q; }, 60);
});
</script></body></html>`;

const SAVED = (q: URLSearchParams) => `<!doctype html><html><head><title>Saved</title></head><body><h1>Saved</h1>
<div role="table" class="list"><div role="rowgroup"><div role="row"><div role="columnheader">Id<div style="display:none">Ascending Descending</div></div><div role="columnheader">Name</div><div role="columnheader">Gender</div><div role="columnheader">Photo</div></div></div>
<div role="rowgroup"><div class="card"><div role="row"><div role="cell">${q.get('id')}</div><div role="cell">${q.get('first')} ${q.get('last')}</div><div role="cell">${q.get('g') === '2' ? 'Female' : q.get('g') === '1' ? 'Male' : ''}</div><div role="cell">${q.get('photo')}</div></div></div></div></div></body></html>`;

let server: Server;
let base = '';
let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eztest-kit-forms-'));
  await writeFile(join(dir, 'photo.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(u.pathname === '/saved' ? SAVED(u.searchParams) : FORM);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server?.close(r));
});

describe('component-kit forms in a real browser', () => {
  it('fills fields by the label beside them, uploads behind a picture, checks a custom radio, sees a toast across navigation, reads a div table', async () => {
    const journey = parseEzScript([
      'Journey: Add employee on a component-kit form',
      'Variables: last=Okafor${tag}, empId=${tag}1',
      '',
      'Open /',
      'Type "Mira" into the "First Name" field',
      'Type "${last}" into the "Last Name" field',
      'Type "${empId}" into the "Employee Id" field',
      'Upload "photo.png" to the "profile picture"',
      'Check the "Female" radio button',
      'Watch for toasts',
      'Click the "Save" button',
      'Expect a toast containing "Successfully Saved"',
      'Capture the rows of the table as rows',
      'Expect ${rows.0.Id} equals "${empId}"',
      'Expect ${rows.0.Name} equals "Mira ${last}"',
      'Expect ${rows.0.Gender} equals "Female"',
      'Expect ${rows.0.Photo} equals "photo.png"',
      '',
    ].join('\n'));
    const started = Date.now();
    const run = await runJourneys([journey], { outputDir: join(dir, 'out'), baseUrl: base, baseDir: dir, variables: { tag: 'kt7' } });
    const j = run.journeys[0];
    const bad = j.steps.filter((s) => s.status !== 'passed').map((s) => `${s.intent}: ${s.error?.message}`);
    expect(bad).toEqual([]);
    expect(j.ledger.rows).toEqual([{ Id: 'kt71', Name: 'Mira Okaforkt7', Gender: 'Female', Photo: 'photo.png' }]);
    // The custom radio is not "covered by an overlay": no wait for the step timeout.
    const radio = j.steps.find((s) => s.intent.startsWith('Check the "Female"'))!;
    expect(radio.reliability?.waits ?? []).toEqual([]);
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 120_000);

  it('keeps strictness: a label over several fields names none of them', async () => {
    const journey = parseEzScript('Journey: Ambiguous visual label\n\nOpen /\nType "x" into the "Employee Full Name" field [timeout=1s]\n');
    const run = await runJourneys([journey], { outputDir: join(dir, 'out2'), baseUrl: base });
    expect(run.journeys[0].steps[1].status).toBe('failed');
    expect(run.journeys[0].steps[1].error?.message).toMatch(/no locator candidate matched exactly one element/);
  }, 60_000);
});

describe('journey variables, one-time codes', () => {
  it('resolves variables that refer to run variables and to each other, leaving unknown names', () => {
    expect(resolveVariableRefs({ last: 'Okafor${tag}', id: '${last}-${n}', self: '${self}x', other: '${nope}' }, { tag: 'T1', n: 2 })).toEqual({ last: 'OkaforT1', id: 'OkaforT1-2', self: '${self}x', other: '${nope}' });
  });

  it('parses the one-time code step', () => {
    const s = parseIntent('Type the one-time code from ${totpSecret} into the "One-time code" field');
    expect(s).toMatchObject({ action: 'fill', args: { totp: '${totpSecret}' }, target: { description: 'the "One-time code" field' } });
    expect(parseIntent('Enter the TOTP code for ${seed} in the Code field')).toMatchObject({ action: 'fill', args: { totp: '${seed}' } });
  });

  it('never types the same window\'s code twice for one secret', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const o = { step: 2 };
    const first = await freshTotp(secret, o);
    const c1 = totpCounter(o);
    const second = await freshTotp(secret, o);
    const c2 = totpCounter(o);
    expect(c2).toBeGreaterThan(c1);
    expect(second).toBe(generateTotp(secret, o));
    expect(first).toBe(generateTotp(secret, { ...o, time: Number(c1) * 2000 }));
  }, 20_000);
});
