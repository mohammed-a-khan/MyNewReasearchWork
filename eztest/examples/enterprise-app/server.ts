/**
 * EZ Enterprise: a test target full of the widgets that defeat naive UI
 * automation, served by a small Node server. Used by the component-adapter
 * e2e suites (test/e2e/components-*.test.ts) and as a demo:
 *
 *   npx tsx examples/enterprise-app/server.ts            # http://127.0.0.1:4400
 *
 * Real open-source libraries (MIT / Apache-2.0, devDependencies) are bundled
 * with esbuild on first request: ag-Grid Community, MUI (Material, X Data
 * Grid, X Date Pickers), Chart.js, Apache ECharts, TinyMCE 6, IMask and
 * noUiSlider. Commercial or non-permissive libraries (Kendo UI, Telerik,
 * DevExtreme, Highcharts, CKEditor 5) and libraries that need their own
 * framework compiler or loader (Angular Material, PrimeNG/PrimeFaces, Oracle
 * JET, SAP UI5, Quill) are emulated: hand-written fixtures that reproduce
 * their documented DOM and class structure (client/emulated/*). See
 * docs/components.md for which adapters are tested against which.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchCities } from './data.js';
import { renderPage, PAGES } from './pages.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLIENT = join(HERE, 'client');

/** Client entries bundled on demand (one IIFE each). */
const ENTRIES: Record<string, string> = {
  aggrid: 'aggrid.ts',
  mui: 'mui.tsx',
  emulated: 'emulated/index.ts',
  charts: 'charts.ts',
  widgets: 'widgets.ts',
};

const bundles = new Map<string, Promise<string>>();

async function bundle(name: string): Promise<string> {
  const file = ENTRIES[name];
  if (!file) throw new Error(`no client entry "${name}"`);
  let p = bundles.get(name);
  if (!p) {
    p = (async () => {
      const esbuild = await import('esbuild');
      const r = await esbuild.build({
        entryPoints: [join(CLIENT, file)],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: ['chrome110'],
        jsx: 'automatic',
        minify: true,
        legalComments: 'none',
        logLevel: 'silent',
        define: { 'process.env.NODE_ENV': '"production"' },
        loader: { '.css': 'text' },
      });
      return r.outputFiles[0].text;
    })();
    bundles.set(name, p);
    p.catch(() => bundles.delete(name));
  }
  return p;
}

const TYPES: Record<string, string> = { '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

/** Static files of an installed package (TinyMCE loads its theme, skin and models at run time). */
async function vendor(res: ServerResponse, pkg: string, rel: string): Promise<void> {
  const base = join(ROOT, 'node_modules', pkg);
  const file = normalize(join(base, rel));
  if (!file.startsWith(base) || !existsSync(file)) return send(res, 404, 'text/plain', 'not found');
  send(res, 200, TYPES[extname(file)] ?? 'application/octet-stream', await readFile(file));
}

export interface EnterpriseApp {
  url: string;
  close(): Promise<void>;
}

export interface EnterpriseOptions {
  port?: number;
  host?: string;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  if (path.startsWith('/assets/') && path.endsWith('.js')) {
    return send(res, 200, 'application/javascript', await bundle(path.slice('/assets/'.length, -3)));
  }
  if (path.startsWith('/vendor/tinymce/')) return vendor(res, 'tinymce', path.slice('/vendor/tinymce/'.length));
  if (path === '/api/cities') {
    // Async options with latency, like a real lookup service.
    const delay = Math.min(Number(url.searchParams.get('delay') ?? 250), 3000);
    await new Promise((r) => setTimeout(r, delay));
    return send(res, 200, 'application/json', JSON.stringify(searchCities(url.searchParams.get('q') ?? '')));
  }
  if (path === '/upload' && req.method === 'POST') {
    let n = 0;
    for await (const chunk of req) n += (chunk as Buffer).length;
    return send(res, 200, 'application/json', JSON.stringify({ received: n }));
  }
  const html = renderPage(path, url.searchParams);
  if (html !== undefined) return send(res, 200, 'text/html; charset=utf-8', html);
  send(res, 404, 'text/plain', `no page ${path}; pages: ${Object.keys(PAGES).join(', ')}`);
}

export async function startEnterpriseApp(opts: EnterpriseOptions = {}): Promise<EnterpriseApp> {
  const server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => send(res, 500, 'text/plain', e.stack ?? e.message));
  });
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((r) => server.listen(opts.port ?? 0, host, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://${host}:${port}`,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

/** Bundle every client entry up front (tests call this once so no page waits on esbuild). */
export async function prebuildClients(): Promise<void> {
  await Promise.all(Object.keys(ENTRIES).map(bundle));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = await startEnterpriseApp({ port: Number(process.env.PORT ?? 4400) });
  console.log(`EZ Enterprise running at ${app.url}`);
}
