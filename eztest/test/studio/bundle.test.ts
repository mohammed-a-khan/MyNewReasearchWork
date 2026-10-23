/** The client bundle: built with esbuild, safe (no eval/innerHTML), prebuilt preferred, served by the Studio. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClient, loadClient, startStudio, type StudioHandle } from '../../src/studio/index.js';
import { copyShopProject, raw } from './helpers.js';

describe('Studio client bundle', () => {
  it('bundles the TypeScript client and CSS into one file each, without unsafe DOM or eval APIs', async () => {
    const out = await mkdtemp(join(tmpdir(), 'ez-bundle-'));
    const b = await buildClient({ outDir: out });
    expect(b.origin).toBe('source');
    expect(b.js.length).toBeGreaterThan(50_000);
    expect(await readFile(join(out, 'app.js'), 'utf8')).toBe(b.js);
    expect(existsSync(join(out, 'app.css'))).toBe(true);
    for (const bad of [/\beval\(/, /new Function\b/, /\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write\(/]) expect(b.js, String(bad)).not.toMatch(bad);
    // CodeMirror is bundled, not fetched; no remote URLs are loaded.
    expect(b.js).not.toMatch(/https?:\/\/(?:cdn|unpkg|esm\.sh)/);
    expect(b.css).toMatch(/--accent:/);
    expect(b.css).toMatch(/prefers-color-scheme: ?dark/);
    expect(b.css).not.toMatch(/@import/);
  });

  it('prefers a prebuilt bundle (the published package) over building from source', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ez-prebuilt-'));
    await mkdir(join(base, 'client'));
    await writeFile(join(base, 'client', 'app.js'), 'console.log("prebuilt")');
    await writeFile(join(base, 'client', 'app.css'), 'body{}');
    const b = await loadClient(base);
    expect(b).toEqual({ js: 'console.log("prebuilt")', css: 'body{}', origin: 'prebuilt' });
  });

  it('fails with a clear message when there is neither a bundle nor sources', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ez-nobundle-'));
    await expect(loadClient(base)).rejects.toThrow(/client sources not found/);
  });
});

describe('serving the bundle', () => {
  let studio: StudioHandle;
  beforeAll(async () => {
    studio = await startStudio({ cwd: await copyShopProject(), watch: false });
  });
  afterAll(async () => studio?.close());

  it('serves app.js and app.css publicly and the page with a strict CSP', async () => {
    const js = await raw(studio.port, '/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/text\/javascript/);
    expect(js.body).toContain('eztest-token');
    const css = await raw(studio.port, '/app.css');
    expect(css.headers['content-type']).toMatch(/text\/css/);
    const page = await raw(studio.port, `/?token=${studio.token}`);
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toMatch(/script-src 'self';/);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    const nonce = /style-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(page.body).toContain(`<meta name="eztest-style-nonce" content="${nonce}">`);
    expect(page.body).not.toMatch(/<script>|<style>|\son\w+=/);
    expect(page.body).toContain('<script src="/app.js" defer></script>');
    // A fresh nonce per page load.
    const again = await raw(studio.port, `/?token=${studio.token}`);
    expect(String(again.headers['content-security-policy'])).not.toContain(nonce!);
  });
});
