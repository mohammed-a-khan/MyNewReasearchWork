/**
 * The image + OCR rung: template matching on fixture screenshots (real), OCR
 * with tesseract.js (real, optional peer; skipped only when it is not
 * installed), the VNC client against a protocol fixture server (the RFB server
 * is ours, so this is protocol-level, not a real Citrix desktop), and canvas
 * journeys in Chromium (real).
 */
import { createRequire } from 'node:module';
import { readFile, mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { flattenStepResults, type JourneyResult } from '../../src/core/index.js';
import { RfbClient, TesseractOcr, createDesktopIntegration, desEncrypt, findTemplate, findText, grayFromPng, vncAuthResponse } from '../../src/desktop/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys, type RunOptions } from '../../src/runner/index.js';
import { RfbTestServer } from './fixtures/rfb-server.js';

const FIX = resolve('test/desktop/fixtures/vision');
const png = (n: string) => readFile(join(FIX, n));
let hasTesseract = false;
try {
  createRequire(import.meta.url).resolve('tesseract.js');
  createRequire(import.meta.url).resolve('@tesseract.js-data/eng/package.json');
  hasTesseract = true;
} catch {
  hasTesseract = false;
}
const describeSteps = (j: JourneyResult) => flattenStepResults(j.steps).map(({ result: s }) => `${s.intent}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');

async function runEz(ez: string, opts: Partial<RunOptions> & { citrix?: Record<string, unknown> } = {}) {
  const outputDir = opts.outputDir ?? (await mkdtemp(join(tmpdir(), 'eztest-vision-')));
  const integration = createDesktopIntegration({ citrix: { images: FIX, ...(opts.citrix ?? {}) } }, { baseDir: process.cwd(), resolveSecret: async () => 'vncpass' });
  const r = await runJourneys([parseEzScript(ez)], { outputDir, stepTimeoutMs: 15_000, conditionTimeoutMs: 8000, stepInterceptors: [integration.interceptor], ...opts });
  return { run: r, j: r.journeys[0], outputDir };
}

describe('template matching (normalised cross-correlation)', () => {
  it('finds the OK button exactly once at 100% and at 125% DPI, and not the Cancel button', async () => {
    const tpl = grayFromPng(await png('ok-button.png'));
    const at100 = findTemplate(grayFromPng(await png('screen.png')), tpl);
    expect(at100).toHaveLength(1);
    expect(at100[0]).toMatchObject({ x: 558, y: 298, scale: 1 });
    expect(at100[0].score).toBeGreaterThan(0.99);
    const at125 = findTemplate(grayFromPng(await png('screen-125.png')), tpl);
    expect(at125).toHaveLength(1);
    expect(at125[0].scale).toBe(1.25);
    // The button's centre (615, 322) at 125% is (769, 402.5); the match centre is within 3 px.
    expect(Math.abs(at125[0].x + at125[0].width / 2 - 615 * 1.25)).toBeLessThanOrEqual(3);
    expect(Math.abs(at125[0].y + at125[0].height / 2 - 322 * 1.25)).toBeLessThanOrEqual(3);
    // Only the template scale that fits is accepted (no 100% match on the 125% screen).
    expect(findTemplate(grayFromPng(await png('screen-125.png')), tpl, { scales: [1] })).toHaveLength(0);
  });

  it('refuses a flat template', async () => {
    const flat = { width: 20, height: 20, data: new Float32Array(400).fill(128) };
    expect(findTemplate(grayFromPng(await png('screen.png')), flat)).toEqual([]);
  });
});

describe('VNC authentication DES', () => {
  it('matches the FIPS test vector and the VNC key bit order', () => {
    expect(desEncrypt(Buffer.from('133457799BBCDFF1', 'hex'), Buffer.from('0123456789ABCDEF', 'hex')).toString('hex')).toBe('85e813540f0ab405');
    // Same challenge + password always gives the same 16-byte response; a different password does not.
    const ch = Buffer.alloc(16, 7);
    expect(vncAuthResponse('secret', ch)).toHaveLength(16);
    expect(vncAuthResponse('secret', ch).equals(vncAuthResponse('secret', ch))).toBe(true);
    expect(vncAuthResponse('secret', ch).equals(vncAuthResponse('secreT', ch))).toBe(false);
  });
});

describe('VNC (RFB 3.8) client against a protocol fixture server', () => {
  let srv: RfbTestServer;
  beforeAll(async () => {
    srv = new RfbTestServer(join(FIX, 'screen.png'), 'vncpass');
    await srv.start();
  });
  afterAll(() => srv.stop());

  it('authenticates, reads the framebuffer as PNG, sends pointer and key events', async () => {
    const c = await RfbClient.connect({ host: '127.0.0.1', port: srv.port, password: 'vncpass' });
    try {
      expect([c.width, c.height, c.name]).toEqual([800, 400, 'ez-test-desktop']);
      const frame = grayFromPng(await c.capture());
      const ok = findTemplate(frame, grayFromPng(await png('ok-button.png')));
      expect(ok[0]).toMatchObject({ x: 558, y: 298 });
      await c.click(615, 322);
      c.keys('Ctrl+S');
      c.type('Hi');
      await new Promise((r) => setTimeout(r, 200));
      expect(srv.clicks.at(-1)).toEqual({ x: 615, y: 322 });
      expect(srv.keys.filter((k) => k.down).map((k) => k.keysym)).toEqual([0xffe3, 0x53, 0x48, 0x69]);
    } finally {
      c.close();
    }
    await expect(RfbClient.connect({ host: '127.0.0.1', port: srv.port, password: 'wrong' })).rejects.toThrow(/authentication failed/i);
  });

  it('drives a Citrix-style session by image from a journey; evidence holds the match box', async () => {
    const before = srv.clicks.length;
    const { j, run, outputDir } = await runEz(`Journey: Citrix by image
Connect to Citrix "desk1"
Click the image "ok-button.png"
`, { citrix: { sessions: { desk1: { vnc: `127.0.0.1:${srv.port}`, password: 'secret://env/VNC' } } } });
    expect(j.status, describeSteps(j)).toBe('passed');
    const click = j.steps[1];
    expect(click.surface).toMatchObject({ driver: 'vision', rung: 'image', box: { x: 558, y: 298, width: 114, height: 48 } });
    await new Promise((r) => setTimeout(r, 100));
    expect(srv.clicks.slice(before).at(-1)).toEqual({ x: 615, y: 322 });
    const manifest = (await readFile(join(outputDir, run.runId, 'evidence-manifest.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { id: string; path: string; kind: string });
    const json = manifest.find((e) => click.evidence.includes(e.id) && e.kind === 'data')!;
    expect(JSON.parse(await readFile(join(outputDir, run.runId, json.path), 'utf8'))).toMatchObject({ matches: [{ x: 558, y: 298, scale: 1 }], clicks: [{ x: 615, y: 322 }] });
  });
});

(hasTesseract ? describe : describe.skip)('OCR with tesseract.js (local WebAssembly, no service)', () => {
  it('finds phrases with their boxes and reads a region', async () => {
    const ocr = new TesseractOcr({ baseDir: process.cwd() });
    try {
      const words = await ocr.recognize(await png('screen.png'));
      const submit = findText(words, 'Submit order');
      expect(submit).toHaveLength(1);
      expect(submit[0].box.x).toBeGreaterThanOrEqual(36);
      expect(submit[0].box.x).toBeLessThanOrEqual(46);
      expect(findText(words, 'Citrix Orders')).toHaveLength(1);
      expect(findText(words, 'Delete')).toHaveLength(0);
    } finally {
      await ocr.close();
    }
  }, 60_000);

  it('a journey on a still screen image: OCR click, image click, region read, screen text', async () => {
    const { j } = await runEz(`Journey: Read the order screen
Use the screen image "test/desktop/fixtures/vision/screen.png"
Expect the screen to contain "Citrix Orders"
Click the text "Submit order" on screen
Double-click the image "ok-button.png"
Read the text in region 30,140,250,30 as total
`);
    expect(j.status, describeSteps(j)).toBe('passed');
    expect(String(j.ledger.total)).toBe('Total: 1,234.50');
    expect(j.steps[1].surface).toMatchObject({ driver: 'vision', rung: 'ocr' });
    expect(j.steps[2].surface).toMatchObject({ driver: 'vision', rung: 'image' });
  }, 90_000);
});

// A canvas-only app in the real browser: no DOM to locate, only pixels.
const CANVAS = `<!doctype html><html><head><title>Canvas app</title></head><body style="margin:0">
<canvas id="c" width="800" height="400"></canvas><p id="log">none</p>
<script>
const c = document.getElementById('c');
const x = c.getContext('2d');
x.fillStyle = '#fff'; x.fillRect(0, 0, 800, 400);
x.fillStyle = '#000'; x.font = '28px sans-serif';
x.fillText('OK', 300, 200);
const m = x.measureText('OK');
const glyph = { x: 300 + m.width / 2, y: 200 - (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 };
const img = new Image();
img.onload = () => x.drawImage(img, 500, 250, img.width * 1.25, img.height * 1.25);
img.src = '/ok-button.png';
const btn = { x: 500 + 2 * 1.25, y: 250 + 2 * 1.25, w: 110 * 1.25, h: 44 * 1.25 };
c.addEventListener('click', (e) => {
  const r = c.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  const d = Math.hypot(px - glyph.x, py - glyph.y);
  const onBtn = px >= btn.x && px <= btn.x + btn.w && py >= btn.y && py <= btn.y + btn.h;
  document.getElementById('log').textContent = onBtn ? 'button hit' : d <= 3 ? 'glyph hit within 3px' : 'miss ' + d.toFixed(1);
});
</script></body></html>`;

describe('canvas app in Chromium (pixels only)', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const ok = await png('ok-button.png');
    server = createServer((req, res) => {
      if (req.url === '/ok-button.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(ok);
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(CANVAS);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('clicks a template drawn at 125% scale on a canvas', async () => {
    const { j } = await runEz(`Journey: Canvas image click
Open ${base}/
Use the browser page as the screen
Wait for the image "ok-button.png" on screen
Click the image "ok-button.png"
Switch to the browser
Expect the page to contain "button hit"
`, { viewport: { width: 800, height: 600 } });
    expect(j.status, describeSteps(j)).toBe('passed');
    expect(j.steps[3].surface?.via).toMatch(/at 125%/);
  });

  (hasTesseract ? it : it.skip)('clicks the text "OK" on a canvas within 3 px of the glyph centre (OCR)', async () => {
    const { j } = await runEz(`Journey: Canvas OCR click
Open ${base}/
Use the browser page as the screen
Click the text "OK" on screen
Switch to the browser
Expect the page to contain "glyph hit within 3px"
`, { viewport: { width: 800, height: 600 } });
    expect(j.status, describeSteps(j)).toBe('passed');
  }, 90_000);
});
