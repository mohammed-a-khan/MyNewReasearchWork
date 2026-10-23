/**
 * pdf.js for the document viewer, self-hosted (no CDN) and CSP compatible:
 * the library and its worker are bundled with esbuild into two ES modules
 * served from `/assets/pdfjs/` (script-src 'self' covers module imports and
 * module workers). The viewer always opens documents with
 * `isEvalSupported: false`, so pdf.js never needs 'unsafe-eval'.
 *
 * Published package: `npm run build` writes `dist/studio/client/pdfjs/*.mjs`.
 * From source: bundled in memory on first request. If esbuild is absent,
 * the prebuilt `pdfjs-dist/build/*.min.mjs` files (a runtime dependency) are served.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendText } from '../http.js';
import type { StudioRoute } from './route.js';

export const PDFJS_FILES = { lib: 'pdf.mjs', worker: 'pdf.worker.mjs' } as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function pdfjsBuildDir(): string {
  return dirname(require.resolve('pdfjs-dist/build/pdf.mjs'));
}

/** Bundle pdf.js and its worker with esbuild (minified ES modules). */
export async function buildPdfAssets(opts: { outDir?: string } = {}): Promise<Record<string, string>> {
  const esbuild = await import('esbuild');
  const dir = pdfjsBuildDir();
  const out: Record<string, string> = {};
  for (const f of Object.values(PDFJS_FILES)) {
    const r = await esbuild.build({
      entryPoints: [join(dir, f)], bundle: true, write: false, format: 'esm', platform: 'browser', minify: true,
      target: ['es2022'], logLevel: 'silent', legalComments: 'none', charset: 'utf8',
    });
    out[f] = r.outputFiles?.[0]?.text ?? '';
    if (!out[f]) throw new Error(`esbuild produced no output for ${f}`);
  }
  if (opts.outDir) {
    await mkdir(opts.outDir, { recursive: true });
    for (const [f, text] of Object.entries(out)) await writeFile(join(opts.outDir, f), text);
  }
  return out;
}

let cache: Promise<Record<string, string>> | undefined;

async function loadPdfAssets(): Promise<Record<string, string>> {
  // 1. prebuilt (dist/studio/client/pdfjs), 2. bundled from source, 3. pdfjs-dist's own minified build.
  const prebuilt = join(HERE, '..', 'client', 'pdfjs');
  if (Object.values(PDFJS_FILES).every((f) => existsSync(join(prebuilt, f)))) {
    const out: Record<string, string> = {};
    for (const f of Object.values(PDFJS_FILES)) out[f] = await readFile(join(prebuilt, f), 'utf8');
    return out;
  }
  try {
    return await buildPdfAssets();
  } catch {
    const dir = pdfjsBuildDir();
    return {
      [PDFJS_FILES.lib]: await readFile(join(dir, 'pdf.min.mjs'), 'utf8'),
      [PDFJS_FILES.worker]: await readFile(join(dir, 'pdf.worker.min.mjs'), 'utf8'),
    };
  }
}

function assets(): Promise<Record<string, string>> {
  cache ??= loadPdfAssets();
  cache.catch(() => (cache = undefined));
  return cache;
}

export const pdfjsRoutes: StudioRoute[] = [
  {
    method: ['GET', 'HEAD'],
    path: /^\/assets\/pdfjs\/(pdf\.mjs|pdf\.worker\.mjs)$/,
    auth: 'public',
    summary: 'pdf.js library and worker (self-hosted, bundled)',
    async handler({ res, params, method }) {
      const a = await assets();
      res.setHeader('Cache-Control', 'private, max-age=3600');
      sendText(res, 200, 'text/javascript; charset=utf-8', a[params[0]], method === 'HEAD');
    },
  },
  {
    method: ['GET', 'HEAD'],
    path: /^\/assets\/pdfjs\/standard_fonts\/([A-Za-z0-9_-]+\.(?:pfb|ttf))$/,
    auth: 'public',
    summary: 'pdf.js standard font data (for PDFs that do not embed their fonts)',
    async handler({ res, params, method }) {
      const file = join(dirname(pdfjsBuildDir()), 'standard_fonts', params[0]);
      if (!existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader('Cache-Control', 'private, max-age=86400');
      sendText(res, 200, params[0].endsWith('.ttf') ? 'font/ttf' : 'application/octet-stream', await readFile(file), method === 'HEAD');
    },
  },
];
