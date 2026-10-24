/**
 * EZTest words its messages itself. Its browser driver once carried error
 * texts and log lines that read exactly like another browser-automation
 * library's; they were rewritten in EZTest's own voice. This test keeps them
 * out: it fails when any of the known verbatim texts below appears again in
 * the product source (src/) or the device agents (agents/).
 *
 * Recognisers are allowed to match such texts (e.g. a triage rule that reads
 * an imported run's old message) only when they are regular expressions that
 * split the phrase; plain copies of the sentences are not.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '../support/testkit.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Texts that match another automation library's messages word for word. */
export const FOREIGN_TEXTS: readonly string[] = [
  'strict mode violation',
  'which is already handled!',
  'JSHandles can be evaluated only in the context they were created',
  'JSHandle is disposed',
  'Target page, context or browser has been closed',
  'Call log:',
  '=========================== logs ===========================',
  'Element is not attached to the DOM',
  'intercepts pointer events',
  'element is not stable',
  'element is outside of the viewport',
  'has been already registered',
  'Route is already handled',
  'Tracing has been already started',
  'most likely because of a navigation',
  'Navigation failed because page was closed',
  'Download is starting',
  'when you are creating your browser context',
  'for multi-page scripts',
  'Cookie should have a url or a domain/path pair',
  'Service Worker requests do not have an associated frame',
  'Response body is unavailable for redirect responses',
  'Cannot type text into input[type=number]',
  'cannot be filled',
  'or [contenteditable] element',
  'Element is not a <select> element',
  'Node is not an <input>, <textarea> or <select> element',
  'Node is not an HTMLInputElement',
  'Non-multiple file input can only accept single file',
  'File paths cannot be mixed with buffers',
  'Clicking the checkbox did not change its state',
  'Failed to find element matching selector',
  'Either path or content property must be present',
  'hasTouch must be enabled on the browser context',
  'Locators must belong to the same frame',
  'Not a checkbox or radio button',
  'exceeded while waiting for event',
];

/** A list of `file:line: text` for every foreign text found in the files. */
export function findForeignTexts(files: Array<{ path: string; text: string }>, texts: readonly string[] = FOREIGN_TEXTS): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const lines = f.text.split('\n');
    lines.forEach((line, i) => {
      for (const t of texts) if (line.includes(t)) hits.push(`${f.path}:${i + 1}: "${t}"`);
    });
  }
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'build' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(?:[cm]?[jt]sx?|swift|kt|java|html|css|json)$/.test(name)) out.push(p);
  }
  return out;
}

describe('own wording', () => {
  it('finds a planted foreign text (the scanner works)', () => {
    const hits = findForeignTexts([
      { path: 'a.ts', text: "ok line\nthrow new Error('Cannot accept dialog which is already handled!');" },
      { path: 'b.ts', text: 'nothing here' },
    ]);
    expect(hits).toEqual(['a.ts:2: "which is already handled!"']);
  });

  it('no known foreign message text appears in src/ or agents/', () => {
    const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'agents'))].map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
    expect(files.length).toBeGreaterThan(500);
    expect(findForeignTexts(files)).toEqual([]);
  });
});
