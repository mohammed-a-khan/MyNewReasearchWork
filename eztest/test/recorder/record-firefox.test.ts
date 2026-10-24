/**
 * Recording on Firefox: an editor iframe its page writes with document.open() (Firefox erases the window's
 * listeners then) and an HTML5 drag and drop (Firefox's WebDriver ends the drag without a drop). Runs on
 * Chromium too; the Firefox half runs when a Firefox is found.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { findFirefox } from '../../src/browser/firefox/launch.js';
import { startRecording } from '../../src/recorder/index.js';

const PAGES: Record<string, string> = {
  '/editor': `<!doctype html><title>Editor</title><h1>Notes</h1><iframe id="ed" title="Rich Text Area"></iframe><script>
    const d = document.getElementById('ed').contentDocument;
    d.open();
    d.write('<!doctype html><body contenteditable="true" aria-label="Note text"><p><br></p></body>');
    d.close();
  </script>`,
  '/drag': `<!doctype html><title>Board</title>
    <div id="a" draggable="true" style="width:120px;height:80px;background:#ccc">Card</div>
    <div id="b" style="width:120px;height:80px;margin-top:40px;background:#eee">Done column</div><script>
    document.getElementById('a').addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'a'));
    document.getElementById('b').addEventListener('dragover', (e) => e.preventDefault());
    document.getElementById('b').addEventListener('drop', (e) => { e.preventDefault(); e.currentTarget.textContent = 'Done: Card'; });
  </script>`,
};

const firefoxPath = (() => {
  try {
    return findFirefox().executablePath;
  } catch {
    return undefined;
  }
})();

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = PAGES[new URL(req.url ?? '/', 'http://x').pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const browser of ['chromium', 'firefox'] as const) {
  describe.skipIf(browser === 'firefox' && !firefoxPath)(`recording on ${browser}`, () => {
    it('records typing into an iframe the page wrote with document.open()', async () => {
      const rec = await startRecording({ url: `${base}/editor`, browser, headless: true });
      try {
        const body = rec.page.frameLocator('#ed').locator('body');
        const box = (await body.boundingBox())!;
        await rec.page.mouse.click(box.x + 20, box.y + 10);
        await rec.page.keyboard.type('Remember the milk', { delay: 10 });
        await sleep(300);
        await rec.page.mouse.click(10, 10);
        await sleep(500);
      } catch (e) {
        await rec.stop().catch(() => undefined);
        throw e;
      }
      const r = await rec.stop();
      expect(r.ez).toContain('In frame "Rich Text Area"\n  Type "Remember the milk" into the "Note text" field\nEnd');
    }, 60_000);

    it('records an HTML5 drag and drop', async () => {
      const rec = await startRecording({ url: `${base}/drag`, browser, headless: true });
      try {
        const a = (await rec.page.locator('#a').boundingBox())!;
        const b = (await rec.page.locator('#b').boundingBox())!;
        await rec.page.mouse.move(a.x + 60, a.y + 40);
        await rec.page.mouse.down();
        await rec.page.mouse.move(a.x + 70, a.y + 45, { steps: 3 });
        await rec.page.mouse.move(b.x + 60, b.y + 40, { steps: 10 });
        await rec.page.mouse.up();
        await sleep(500);
        expect(await rec.page.locator('#b').textContent()).toBe('Done: Card');
      } catch (e) {
        await rec.stop().catch(() => undefined);
        throw e;
      }
      const r = await rec.stop();
      expect(r.ez).toContain('\nDrag #a to #b\n');
    }, 60_000);
  });
}
