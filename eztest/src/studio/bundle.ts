/**
 * The Studio client bundle (one JS file, one CSS file).
 *
 * Published package: `npm run build` emits `dist/studio/client/app.{js,css}`
 * (scripts/build-studio.mjs calls `buildClient`), and the server serves them.
 * From source (tsx, EZTest's testkit): there is no prebuilt bundle next to this file, so
 * the server bundles `client/main.ts` in memory with esbuild on first request.
 * If neither is possible the error says how to fix it.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ClientBundle {
  js: string;
  css: string;
  /** "prebuilt" (dist) or "source" (bundled on the fly). */
  origin: 'prebuilt' | 'source';
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the client sources and the prebuilt bundle live for this copy of the Studio. */
export function clientPaths(base = HERE): { entry: string; css: string; prebuiltJs: string; prebuiltCss: string } {
  return {
    entry: join(base, 'client', 'main.ts'),
    css: join(base, 'client', 'styles', 'index.css'),
    prebuiltJs: join(base, 'client', 'app.js'),
    prebuiltCss: join(base, 'client', 'app.css'),
  };
}

export interface BuildOptions {
  /** Directory holding `client/` (default: this module's directory). */
  base?: string;
  minify?: boolean;
  /** Also write `app.js` and `app.css` into this directory. */
  outDir?: string;
}

/** Bundle the client with esbuild (a devDependency; absent from production installs). */
export async function buildClient(opts: BuildOptions = {}): Promise<ClientBundle> {
  const p = clientPaths(opts.base);
  if (!existsSync(p.entry)) throw new Error(`Studio client sources not found at ${p.entry}`);
  let esbuild: typeof import('esbuild');
  try {
    esbuild = await import('esbuild');
  } catch {
    throw new Error(
      'The EZTest Studio client bundle is missing and esbuild is not installed to build it from source. ' +
        'Run "npm run build" (or "npm install" to get the dev dependencies) in the eztest package.',
    );
  }
  const minify = opts.minify ?? true;
  const common = { bundle: true, write: false, minify, logLevel: 'silent' as const, legalComments: 'none' as const, charset: 'utf8' as const };
  const [js, css] = await Promise.all([
    esbuild.build({ ...common, entryPoints: [p.entry], format: 'iife', platform: 'browser', target: ['es2020', 'chrome100', 'firefox100', 'safari15'], outfile: 'app.js' }),
    esbuild.build({ ...common, entryPoints: [p.css], outfile: 'app.css', loader: { '.css': 'css' } }),
  ]);
  const bundle: ClientBundle = { js: js.outputFiles?.[0]?.text ?? '', css: css.outputFiles?.[0]?.text ?? '', origin: 'source' };
  if (!bundle.js) throw new Error('esbuild produced no Studio client bundle');
  if (opts.outDir) {
    await mkdir(opts.outDir, { recursive: true });
    await writeFile(join(opts.outDir, 'app.js'), bundle.js);
    await writeFile(join(opts.outDir, 'app.css'), bundle.css);
  }
  return bundle;
}

const cache = new Map<string, Promise<ClientBundle>>();

/** The bundle to serve: prebuilt when present, else built from source once per process. */
export function loadClient(base = HERE): Promise<ClientBundle> {
  let p = cache.get(base);
  if (!p) {
    p = (async () => {
      const paths = clientPaths(base);
      if (existsSync(paths.prebuiltJs) && existsSync(paths.prebuiltCss)) {
        const [js, css] = await Promise.all([readFile(paths.prebuiltJs, 'utf8'), readFile(paths.prebuiltCss, 'utf8')]);
        return { js, css, origin: 'prebuilt' as const };
      }
      return buildClient({ base });
    })();
    cache.set(base, p);
    // Let a later request retry after a failure (e.g. after "npm run build").
    p.catch(() => cache.delete(base));
  }
  return p;
}
