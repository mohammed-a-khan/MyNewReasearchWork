/**
 * Escaped quotes inside quoted text: `"\"approver\":\s*true"` holds `"approver":\s*true`. The quoted segment
 * ended at the first `\"`, and the grammar's internal placeholders (⟦0⟧) leaked into the pattern:
 * `page text does not match /⟦0⟧approver\⟦1⟧/`. Real browser on a page that shows JSON.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { parseEzScript } from '../../src/intent/index.js';
import { protectQuotes, literal } from '../../src/intent/quotes.js';
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

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Claims</title><pre>{"user": "linus", "approver": true}</pre>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe('escaped quotes in quoted text', () => {
  it('a backslash escapes the segment\'s own quote; other backslashes stay', () => {
    const p = protectQuotes('Expect the page text matches "\\"approver\\":\\s*true"');
    expect(p.quotes).toEqual(['"approver":\\s*true']);
    expect(literal(p.text.replace(/^.*matches /, ''), p.quotes)).toBe('"approver":\\s*true');
    expect(protectQuotes("Type 'it\\'s' into the Name field").quotes).toEqual(["it's"]);
    expect(protectQuotes('Expect the page text matches "\\d+ items"').quotes).toEqual(['\\d+ items']);
    // A segment that ends in a backslash, with no quote after it, still ends at its quote.
    expect(protectQuotes('Upload "C:\\temp\\"').quotes).toEqual(['C:\\temp\\']);
    const j = parseEzScript('Journey: x\nOpen /\nExpect the page text matches "\\"approver\\":\\s*true"\nExpect the page contains "\\"approver\\": true"\n');
    expect(JSON.stringify(j.steps)).not.toContain('⟦');
  });

  it('the page text matches and contains the value with the quotes in it', async () => {
    const out = await tempDirOf(join(tmpdir(), 'ez-escaped-quotes-'));
    const journey = parseEzScript([
      'Journey: Claims',
      '',
      'Open /',
      'Expect the page text matches "\\"approver\\":\\s*true"',
      'Expect the page contains "\\"approver\\": true"',
      'Expect the page does not contain "\\"approver\\": false"',
      '',
    ].join('\n'));
    const run = await runJourneys([journey], { outputDir: out, baseUrl: base, stepTimeoutMs: 5000, conditionTimeoutMs: 2000 });
    const j = run.journeys[0];
    expect(j.status, JSON.stringify(j.steps.map((s) => [s.intent, s.status, s.error?.message]))).toBe('passed');
  }, 60_000);
});
