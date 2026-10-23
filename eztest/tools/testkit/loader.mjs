/**
 * Node module hooks for the EZTest testkit (registered by register.mjs):
 *
 * - load: TypeScript (.ts/.tsx/.mts) is transformed to JavaScript with esbuild,
 *   with an inline source map; results are cached on disk by content hash.
 *   Project files (outside node_modules) that use __dirname, __filename or
 *   require() without declaring them get them, as they had under the old runner.
 * - resolve: `./x.js` falls back to `./x.ts` (TypeScript's NodeNext style),
 *   extensionless and directory imports try .ts / index.ts; and the module
 *   swaps from the testkit config (EZTEST_BROWSER=firefox: src/browser/index.ts
 *   -> test/support/firefox-as-chromium.ts) are applied.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Bump when the transform output changes. */
const TRANSFORM_VERSION = 3;

let swaps = [];
let cacheDir;
let esbuildRequire;
let esbuild;

export async function initialize(data = {}) {
  swaps = (data.swaps ?? []).map((s) => ({ from: pathToFileURL(s.from).href, to: pathToFileURL(s.to).href, except: new Set((s.except ?? []).map((p) => pathToFileURL(p).href)) }));
  cacheDir = data.cacheDir;
  esbuildRequire = createRequire(join(data.root ?? process.cwd(), 'package.json'));
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });
}

const TS_RE = /\.(?:[mc]?ts|tsx)$/;

function candidates(specifier) {
  const out = [];
  const m = /^(.*)\.(js|jsx|mjs|cjs)$/.exec(specifier);
  if (m) {
    const ext = { js: ['.ts', '.tsx'], jsx: ['.tsx'], mjs: ['.mts'], cjs: ['.cts'] }[m[2]];
    for (const e of ext) out.push(m[1] + e);
  } else if (!/\.[a-z0-9]+$/i.test(specifier.split('/').pop() ?? '')) {
    out.push(`${specifier}.ts`, `${specifier}.tsx`, `${specifier}.js`, `${specifier}/index.ts`, `${specifier}/index.js`);
  } else {
    out.push(`${specifier.replace(/\/$/, '')}/index.ts`);
  }
  return out;
}

const isPath = (s) => s.startsWith('./') || s.startsWith('../') || s.startsWith('/') || s.startsWith('file:');

export async function resolve(specifier, context, next) {
  let r;
  const parent = context.parentURL ?? '';
  // Fast path for the common case, `./x.js` naming `./x.ts` from a project file (no failed lookup first).
  if (parent.startsWith('file:') && !parent.includes('/node_modules/') && (specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
    const ts = new URL(`${specifier.slice(0, -3)}.ts`, parent);
    if (!existsSync(new URL(specifier, parent)) && existsSync(ts)) r = await next(ts.href, context);
  }
  if (!r) {
    try {
      r = await next(specifier, context);
    } catch (e) {
      if (!isPath(specifier) || parent.includes('/node_modules/') || (e?.code !== 'ERR_MODULE_NOT_FOUND' && e?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT')) throw e;
      for (const c of candidates(specifier)) {
        try {
          r = await next(c, context);
          break;
        } catch {
          // try the next candidate
        }
      }
      if (!r) throw e;
    }
  }
  for (const s of swaps) {
    if (r.url === s.from && !s.except.has(context.parentURL)) return { ...r, url: s.to, shortCircuit: true };
  }
  return r;
}

function prelude(code) {
  // Injected on the first line (no newline) so the source map's lines stay right.
  let p = '';
  const declares = (name) => new RegExp(String.raw`(?:\b(?:const|let|var|function|class)\s+|\bimport\s+(?:\*\s+as\s+)?)${name}\b`).test(code);
  if (/\b__(?:dirname|filename)\b/.test(code) && !declares('__dirname') && !declares('__filename')) {
    p += "import { fileURLToPath as __eztk_fileURLToPath } from 'node:url'; import { dirname as __eztk_dirname } from 'node:path'; const __filename = __eztk_fileURLToPath(import.meta.url); const __dirname = __eztk_dirname(__filename); ";
  }
  if (/(?<![.\w$])require\s*\(/.test(code) && !declares('require')) {
    p += "import { createRequire as __eztk_createRequire } from 'node:module'; const require = __eztk_createRequire(import.meta.url); ";
  }
  return p;
}

function transform(source, file) {
  const project = !file.includes('/node_modules/');
  let src = source;
  if (project) {
    const p = prelude(source);
    if (p) src = source.startsWith('#!') ? source.replace(/^#!.*/, (l) => `${l}\n${p}`) : p + source;
  }
  const key = createHash('sha1').update(`${TRANSFORM_VERSION}\0${file}\0`).update(src).digest('hex');
  const cached = cacheDir && join(cacheDir, `${key}.js`);
  if (cached) {
    try {
      return readFileSync(cached, 'utf8');
    } catch {
      // not cached yet
    }
  }
  esbuild ??= esbuildRequire('esbuild');
  const tsx = file.endsWith('.tsx');
  const { code } = esbuild.transformSync(src, {
    loader: tsx ? 'tsx' : 'ts',
    format: 'esm',
    target: 'node20',
    sourcemap: 'inline',
    sourcefile: file,
    keepNames: true,
    jsx: tsx ? 'automatic' : undefined,
    tsconfigRaw: { compilerOptions: { target: 'ES2022', useDefineForClassFields: true, verbatimModuleSyntax: false } },
  });
  if (cached) {
    const tmp = `${cached}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, code);
      renameSync(tmp, cached);
    } catch {
      // the cache is best-effort
    }
  }
  return code;
}

export async function load(url, context, next) {
  if (url.startsWith('file:') && TS_RE.test(url.split('?')[0])) {
    const file = fileURLToPath(url);
    if (file.endsWith('.cts')) return next(url, context);
    const source = readFileSync(file, 'utf8');
    return { format: 'module', source: transform(source, file), shortCircuit: true };
  }
  return next(url, context);
}
