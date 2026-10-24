/**
 * A step whose action starts a navigation can end while the page is between documents: a full-page
 * screenshot then fails ("Cannot take screenshot with 0 width") and the step (a healed step: its heal) lost its
 * evidence. The runner waits for the new document and captures it.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { FAST, tempDir } from './fixtures.js';

let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url?.startsWith('/next')) {
      // Headers (and so the URL change) at once, the document a little later.
      res.writeHead(200);
      res.write('<!doctype html><html lang="en"><head><title>Next</title></head>');
      setTimeout(() => res.end('<body><main><h1>Next page</h1></main></body></html>'), 600);
      return;
    }
    res.end('<!doctype html><html lang="en"><head><title>Start</title></head><body><main><form action="/next" method="get"><button type="submit">Go</button></form></main></body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe('step screenshots across a navigation', () => {
  it('a click that navigates still gets its screenshot, of the new page', async () => {
    for (let i = 0; i < 5; i++) {
      const run = await runJourneys([parseEzScript('Journey: Go\nId: go\nOpen "/"\nClick the "Go" button\n  Expect the URL contains "/next"\n')], {
        ...FAST, baseUrl: url, outputDir: await tempDir('shot-nav'), screenshots: 'every-step',
      });
      const click = run.journeys[0].steps.find((s) => s.stepId === 'click-the-go-button')!;
      expect(click.status).toBe('passed');
      expect(click.evidence.length, `attempt ${i}`).toBeGreaterThan(0);
    }
  }, 120_000);
});
