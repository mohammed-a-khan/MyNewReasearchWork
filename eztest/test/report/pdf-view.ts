/**
 * Test support: render a PDF in a real browser with pdf.js (served from
 * node_modules by a local HTTP server) so tests check what a reader sees -
 * each page drawn on a canvas, plus its text and link annotations.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import type { Browser, Page } from '../../src/browser/index.js';

const require = createRequire(import.meta.url);
const PDFJS = dirname(require.resolve('pdfjs-dist/package.json'));

const VIEWER = `<!doctype html><html><head><meta charset="utf-8"><title>pdf</title><style>body{margin:0;background:#888}canvas{display:block;margin:8px auto;background:#fff}</style></head><body>
<script type="module">
import * as pdfjs from '/pdfjs/build/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';
const doc = await pdfjs.getDocument({ url: '/doc.pdf', standardFontDataUrl: '/pdfjs/standard_fonts/' }).promise;
const pages = [];
for (let i = 1; i <= doc.numPages; i++) {
  const p = await doc.getPage(i);
  const vp = p.getViewport({ scale: 1.25 });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height; c.id = 'p' + i;
  document.body.appendChild(c);
  await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const text = (await p.getTextContent()).items.map((x) => x.str).join(' ');
  const links = (await p.getAnnotations()).filter((a) => a.subtype === 'Link').map((a) => a.url || a.unsafeUrl || '');
  // Share of canvas pixels that are not white: a blank page has none.
  const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let ink = 0;
  for (let k = 0; k < px.length; k += 16) if (px[k] < 240 || px[k + 1] < 240 || px[k + 2] < 240) ink++;
  pages.push({ text, links, ink: ink / (px.length / 16), width: c.width, height: c.height });
}
const outline = (await doc.getOutline() || []).map((o) => o.title);
const meta = await doc.getMetadata();
window.__pdf = { pages, outline, title: meta.info.Title, lang: (await doc.getMarkInfo?.()) ?? null };
</script></body></html>`;

export interface RenderedPdf {
  pages: Array<{ text: string; links: string[]; ink: number; width: number; height: number }>;
  outline: string[];
  title: string;
}

/** Serve `pdf` and render it in `browser`; returns the page (for screenshots) and what pdf.js read. */
export async function renderPdfInBrowser(browser: Browser, pdf: Buffer, o: { width?: number } = {}): Promise<{ page: Page; pdf: RenderedPdf; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    try {
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(VIEWER);
      } else if (url === '/doc.pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(pdf);
      } else if (url.startsWith('/pdfjs/')) {
        const file = normalize(join(PDFJS, url.slice('/pdfjs/'.length)));
        if (!file.startsWith(PDFJS)) throw new Error('outside');
        res.writeHead(200, { 'content-type': file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream' });
        res.end(await readFile(file));
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const page = await browser.newPage({ viewport: { width: o.width ?? 900, height: 1200 } });
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => !!(window as unknown as { __pdf?: unknown }).__pdf, undefined, { timeout: 30_000 }).catch(() => undefined);
  const out = (await page.evaluate(() => (window as unknown as { __pdf?: RenderedPdf }).__pdf)) as RenderedPdf | undefined;
  if (!out) throw new Error(`pdf.js could not render the PDF: ${errors.join('; ') || 'timeout'}`);
  return { page, pdf: out, close: async () => { await page.close(); await new Promise<void>((r) => server.close(() => r())); } };
}
