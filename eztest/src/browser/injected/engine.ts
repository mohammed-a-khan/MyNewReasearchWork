/**
 * Node side of the page-side engine: produces the JavaScript the driver
 * evaluates in each frame's engine world (see contract.ts).
 *
 * Published package: `npm run build` writes `dist/browser/injected/engine.bundle.js`
 * (scripts/build-injected.mjs calls `buildEngineSource`) and `engineSource()`
 * reads it. From source (tsx, EZTest's testkit): there is no prebuilt bundle next to
 * this file, so the page modules in `./page/` are bundled in memory with
 * esbuild (a devDependency) on first use. If neither is possible the error
 * says how to fix it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the prebuilt bundle lives for this copy of the engine. */
export const PREBUILT_ENGINE = join(HERE, 'engine.bundle.js');

/** Global used inside the bundle's IIFE; never leaks (the expression wraps it). */
const BUNDLE_GLOBAL = '__eztestEngineModule';

function entryPoint(): string {
  const ts = join(HERE, 'page', 'main.ts');
  if (existsSync(ts)) return ts;
  return join(HERE, 'page', 'main.js');
}

/**
 * Bundle the page modules with esbuild into ONE expression that evaluates to
 * a fresh engine object (an {@link import('./engine-api.js').EztestEngine}).
 */
export function buildEngineSource(opts: { minify?: boolean } = {}): string {
  let esbuild: typeof import('esbuild');
  try {
    esbuild = createRequire(import.meta.url)('esbuild') as typeof import('esbuild');
  } catch {
    throw new Error(
      'The EZTest page engine bundle is missing and esbuild is not installed to build it from source. ' +
        'Run "npm run build" (or "npm install" to get the dev dependencies) in the eztest package.',
    );
  }
  const r = esbuild.buildSync({
    entryPoints: [entryPoint()],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: BUNDLE_GLOBAL,
    platform: 'browser',
    target: ['chrome100'],
    minify: opts.minify ?? true,
    keepNames: false,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
  });
  const code = r.outputFiles?.[0]?.text;
  if (!code) throw new Error('esbuild produced no page engine bundle');
  return `(() => {\n${code}\nreturn ${BUNDLE_GLOBAL}.createEngine();\n})()`;
}

let cached: string | undefined;

/** The engine source: prebuilt when present, else bundled from source once per process. */
export function engineSource(): string {
  if (cached === undefined) cached = existsSync(PREBUILT_ENGINE) ? readFileSync(PREBUILT_ENGINE, 'utf8') : buildEngineSource();
  return cached;
}
