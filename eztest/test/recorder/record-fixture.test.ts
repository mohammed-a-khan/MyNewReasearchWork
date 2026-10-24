/** Checkboxes, radios, uploads, double-click, Enter, password masking and iframes, recorded on a caller-owned page. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '../../src/browser/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { diffJourneys, recordJourney, startRecording, verifyRecording, type RecordingResult } from '../../src/recorder/index.js';

const SECRET = 's3cr3t-Value!';

const PAGES: Record<string, string> = {
  '/form': `<!doctype html><title>Settings</title><h1>Settings</h1>
<form action="/saved" method="get">
  <p><label for="nick">Nickname</label> <input id="nick" name="nick"></p>
  <p><label for="pw">Password</label> <input id="pw" name="password" type="password"></p>
  <p><label><input type="checkbox" name="news"> Newsletter</label></p>
  <p><input type="radio" name="plan" id="basic" value="basic"><label for="basic">Basic</label>
     <input type="radio" name="plan" id="pro" value="pro"><label for="pro">Pro</label></p>
  <p><label for="avatar">Avatar</label> <input type="file" id="avatar" name="avatar"></p>
  <p><button type="button" ondblclick="document.getElementById('out').textContent='Hello!'">Say hello</button></p>
  <p data-testid="greeting" id="out"></p>
  <p><button type="submit">Save</button></p>
</form>`,
  '/saved': '<!doctype html><title>Saved</title><h1>Saved</h1>',
  '/framed': '<!doctype html><title>Framed</title><h1>Help</h1><iframe id="help" src="/inner"></iframe>',
  '/inner': '<!doctype html><button onclick="this.textContent=\'Asked\'">Ask</button>',
};

let server: Server;
let base: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const body = PAGES[path];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('recording form controls', () => {
  let result: RecordingResult;
  const lines: string[] = [];

  beforeAll(async () => {
    const page = await browser.newPage();
    const rec = await startRecording({ url: `${base}/form`, page, name: 'Settings', onStep: (l) => lines.push(l) });
    expect(rec.page).toBe(page);
    await page.getByText('Newsletter').click(); // label click: forwards to the checkbox, must not be a click step
    await page.getByRole('checkbox', { name: 'Newsletter' }).uncheck();
    await page.getByText('Pro', { exact: true }).click();
    await page.getByLabel('Avatar').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
    await page.getByRole('button', { name: 'Say hello' }).dblclick();
    await page.getByTestId('greeting').click({ modifiers: ['Control', 'Alt'] });
    await page.getByLabel('Password').pressSequentially(SECRET);
    await page.getByLabel('Nickname').pressSequentially('neo');
    await page.getByLabel('Nickname').press('Enter');
    await page.waitForURL('**/saved**');
    result = await rec.stop();
    // The caller's page stays open: the recorder did not launch it.
    expect(page.isClosed()).toBe(false);
    await page.close();
  });

  it('records each control as one plain-English step', () => {
    const body = result.ez.split('\n').filter((l) => l && !l.startsWith('#') && !/^(Journey|Description|Tags|Base URL):/.test(l));
    expect(result.ez).toMatch(/^Base URL: http:\/\/127\.0\.0\.1:\d+$/m);
    expect(body).toEqual([
      'Open /form',
      'Check the Newsletter checkbox',
      'Uncheck the Newsletter checkbox',
      'Check the Pro radio button',
      'Upload "me.png" to the Avatar field',
      'Double-click the "Say hello" button',
      '  Expect testid=greeting contains "Hello!"',
      'Type "${password}" into the Password field',
      'Type "neo" into the Nickname field',
      'Press Enter in the Nickname field',
      '  Expect URL contains "/saved"',
    ]);
    expect(lines).toContain('Press Enter in the Nickname field');
    expect(result.warnings.some((w) => /me\.png/.test(w) && /path/.test(w))).toBe(true);
  });

  it('round-trips through .ez and keeps the secret out of every output', () => {
    expect(diffJourneys(result.journey, parseEzScript(result.ez))).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.ez).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it('replays green once the upload path is provided', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-rec-fx-'));
    const file = join(dir, 'me.png');
    await writeFile(file, Buffer.from([137, 80, 78, 71]));
    const journey = { ...result.journey, steps: result.journey.steps.map((s) => (s.action === 'upload' ? { ...s, value: file } : s)) };
    const report = await verifyRecording({ ...result, journey }, { outputDir: dir, variables: { password: 'whatever' }, screenshots: 'off' });
    expect(report.failed).toEqual([]);
    expect(report.passed).toBe(true);
  });
});

describe('recording inside frames and stopping on close', () => {
  it("records actions in a frame as an In frame block, named by the frame's id", async () => {
    const page = await browser.newPage();
    const done = recordJourney({ url: `${base}/framed`, page, until: 'close' });
    await page.frameLocator('#help').getByRole('button', { name: 'Ask' }).click();
    await page.frameLocator('#help').getByRole('button', { name: 'Asked' }).waitFor();
    await new Promise((r) => setTimeout(r, 300));
    await page.close();
    const result = await done;
    const block = result.journey.steps.find((s) => s.action === 'frame');
    expect(block?.args).toEqual({ op: 'enter', path: ['help'] });
    expect(block?.steps?.[0]).toMatchObject({ action: 'click', target: { description: 'the "Ask" button' } });
    expect(block?.steps?.[0].target?.frames).toBeUndefined();
    expect(result.ez).toContain('In frame "help"\n  Click the "Ask" button\nEnd');
    expect(result.warnings).toEqual([]);
    expect(diffJourneys(result.journey, parseEzScript(result.ez))).toEqual([]);
  });

  it('rejects a bad expectation and attaches programmatic ones to the last step', async () => {
    const page = await browser.newPage();
    const rec = await startRecording({ url: `${base}/saved`, page });
    expect(() => rec.addExpectation('wibble wobble')).toThrow(/Cannot understand the expectation/);
    rec.addExpectation('Expect the page contains "Saved"');
    const result = await rec.stop();
    expect(result.journey.steps[0].postconditions).toEqual([{ type: 'pageContainsText', value: 'Saved' }]);
    expect(() => rec.addExpectation('the page contains "x"')).toThrow(/stopped/);
    await page.close();
  });
});

describe('recording for a project', () => {
  async function record(project: { baseUrl?: string }): Promise<RecordingResult> {
    const page = await browser.newPage();
    const rec = await startRecording({ url: `${base}/saved`, page, name: 'Saved page', project });
    const result = await rec.stop();
    await page.close();
    return result;
  }

  it('writes the recorded site as the Base URL when the project has none, so the journey replays', async () => {
    const result = await record({});
    expect(result.ez.split('\n')).toContain(`Base URL: ${base}`);
    const replay = await verifyRecording(result, { headless: true });
    expect(replay.passed).toBe(true);
  });

  it('leaves it out when the project baseUrl is the recorded site, so environments can still switch', async () => {
    const result = await record({ baseUrl: `${base}/` });
    expect(result.ez).not.toMatch(/^Base URL:/m);
  });
});
