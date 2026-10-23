/**
 * The source of the in-page accessibility engine (./page/), built the same
 * way as the selector engine (src/browser/injected/engine.ts): the
 * published package ships `dist/a11y/a11y.bundle.js` (written by
 * scripts/build-injected.mjs after `tsc`); from source the page modules are
 * bundled in memory with esbuild (a devDependency) on first use.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PREBUILT_A11Y = join(HERE, 'a11y.bundle.js');

/** Page global the engine is installed under. */
export const A11Y_GLOBAL = '__eztestA11y';

const BUNDLE_GLOBAL = '__eztestA11yModule';

function entryPoint(): string {
  const ts = join(HERE, 'page', 'main.ts');
  return existsSync(ts) ? ts : join(HERE, 'page', 'main.js');
}

/** Bundle the page modules into one expression that evaluates to a fresh engine object. */
export function buildA11ySource(opts: { minify?: boolean } = {}): string {
  let esbuild: typeof import('esbuild');
  try {
    esbuild = createRequire(import.meta.url)('esbuild') as typeof import('esbuild');
  } catch {
    throw new Error(
      'The EZTest accessibility engine bundle is missing and esbuild is not installed to build it from source. ' +
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
    target: ['chrome100', 'firefox115'],
    minify: opts.minify ?? true,
    keepNames: false,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
  });
  const code = r.outputFiles?.[0]?.text;
  if (!code) throw new Error('esbuild produced no accessibility engine bundle');
  return `(() => {\n${code}\nreturn ${BUNDLE_GLOBAL}.createA11yEngine();\n})()`;
}

let cached: string | undefined;

export function a11ySource(): string {
  if (cached === undefined) cached = existsSync(PREBUILT_A11Y) ? readFileSync(PREBUILT_A11Y, 'utf8') : buildA11ySource();
  return cached;
}
