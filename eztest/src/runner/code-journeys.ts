/**
 * Loading code journeys and code steps (TypeScript modules written with
 * `eztest/sdk`).
 *
 * This is the one place where EZTest loads user code, and it does so with
 * ordinary module loading (`import()` of a file), never `eval` or
 * `new Function`. Which loader is used:
 *
 *  1. `.js` / `.mjs` files are imported as they are.
 *  2. When the process already runs under tsx (`tsx`, `node --import tsx`),
 *     the `.ts` file is imported directly: the runtime compiles it.
 *  3. Otherwise, when esbuild can be loaded (from the project, or EZTest's own
 *     development install), the module and its relative imports are bundled
 *     on the fly into `<project>/.eztest/code-cache/<name>-<hash>.mjs` with a
 *     source map, and that file is imported. Packages stay external (resolved
 *     to absolute paths, so the cache location does not matter), and
 *     `eztest` / `eztest/*` imports are pinned to the EZTest that is running.
 *     The source map maps call sites back to the original lines.
 *  4. Otherwise, when Node strips types itself (Node 22.18+ / 23.6+, or
 *     `--experimental-strip-types`), the `.ts` file is imported directly.
 *     Type stripping needs explicit `.ts` extensions on relative imports and
 *     no TypeScript-only runtime syntax (enums, parameter properties).
 *  5. Otherwise, when the `tsx` package is installed, its `tsImport` API loads it.
 *  6. Otherwise loading fails with a message saying how to fix it (install
 *     esbuild or tsx, or compile journeys to `.journey.js`).
 *
 * `EZTEST_CODE_LOADER=esbuild|native|tsx` forces one strategy.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EzTestError, slugify, type Journey, type JourneyInput } from '../core/index.js';
import { Journey as JourneySchema } from '../core/index.js';
import { decodeSourceMap } from '../sdk/callsite.js';
import { shared, type Registration } from '../sdk/runtime.js';

/** File names that hold code journeys. */
export const CODE_JOURNEY_RE = /\.journey\.(?:ts|mts|js|mjs)$/i;
/** File names that hold code steps (opened with TypeScript highlighting in the Studio). */
export const CODE_STEPS_RE = /\.steps\.(?:ts|mts|js|mjs)$/i;

export function isCodeJourneyFile(path: string): boolean {
  return CODE_JOURNEY_RE.test(path);
}

export type LoaderKind = 'js' | 'tsx-active' | 'esbuild' | 'native' | 'tsx-api';

export interface LoadOptions {
  /** Project root: where the bundle cache lives and where esbuild/tsx are looked up first. Default process.cwd(). */
  cwd?: string;
}

interface Loaded {
  key: string;
  module: Record<string, unknown>;
  registrations: Registration[];
  loader: LoaderKind;
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** src/ or dist/ of this EZTest. */
const ROOT = dirname(HERE);
const cache = new Map<string, Loaded>();
/** Registrations per imported URL: a module URL is evaluated once per process, so a re-import must reuse them. */
const byUrl = new Map<string, { module: Record<string, unknown>; registrations: Registration[] }>();
const inflight = new Map<string, Promise<Loaded>>();

function tsxActive(): boolean {
  const args = [...process.execArgv, process.env.NODE_OPTIONS ?? ''].join(' ');
  return /(?:^|[\\/\s=])tsx(?:[\\/@]|\b)/.test(args);
}

function nodeStripsTypes(): boolean {
  const f = (process as unknown as { features?: { typescript?: unknown } }).features;
  return !!f?.typescript;
}

/** Import an optional package from the project first, then from EZTest's own install. */
async function optionalImport<T>(name: string, cwd: string): Promise<T | undefined> {
  for (const base of [join(cwd, 'package.json'), join(ROOT, '..', 'package.json')]) {
    try {
      const p = createRequire(base).resolve(name);
      return (await import(pathToFileURL(p).href)) as T;
    } catch {
      // try the next base
    }
  }
  try {
    return (await import(name)) as T;
  } catch {
    return undefined;
  }
}

/** Package specifiers that name this EZTest: the npm name, and the bare `eztest` that older projects import. */
const SELF_NAMES = ['@eztech.com/eztest', 'eztest'];
/** Matches `@eztech.com/eztest`, `@eztech.com/eztest/<sub>`, `eztest` and `eztest/<sub>`. */
export const EZTEST_SPECIFIER = /^(?:@eztech\.com\/)?eztest(?:\/.*)?$/;

/** The module of this EZTest that an `@eztech.com/eztest[/<sub>]` (or legacy `eztest[/<sub>]`) import should load. */
export function eztestModulePath(spec: string): string | undefined {
  const name = SELF_NAMES.find((n) => spec === n || spec.startsWith(`${n}/`));
  if (!name) return undefined;
  const sub = spec === name ? '' : spec.slice(name.length + 1);
  if (sub === 'package.json') return join(ROOT, '..', 'package.json');
  if (sub && !/^[a-z0-9-]+$/.test(sub)) return undefined;
  for (const ext of ['.js', '.ts']) {
    const p = sub ? join(ROOT, sub, `index${ext}`) : join(ROOT, `index${ext}`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

type Esbuild = typeof import('esbuild');

async function bundle(esbuild: Esbuild, file: string, cwd: string): Promise<{ out: string; key: string }> {
  const cacheDir = join(cwd, '.eztest', 'code-cache');
  const plugin: import('esbuild').Plugin = {
    name: 'eztest-externals',
    setup(build) {
      // @eztech.com/eztest/* (and legacy eztest/*) -> this EZTest (one runtime for the journey and the runner).
      build.onResolve({ filter: EZTEST_SPECIFIER }, (args) => {
        const p = eztestModulePath(args.path);
        if (!p) return { errors: [{ text: `Unknown EZTest module "${args.path}"` }] };
        return { path: pathToFileURL(p).href, external: true };
      });
      // Other packages stay external, resolved from the importing file so the bundle can live anywhere.
      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData === 'eztest-inner' || /^node:/.test(args.path) || isAbsolute(args.path)) return undefined;
        const r = await build.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: 'eztest-inner' });
        if (r.errors.length) return { errors: r.errors };
        if (r.external || !r.path || !isAbsolute(r.path)) return { path: args.path, external: true };
        return { path: pathToFileURL(r.path).href, external: true };
      });
    },
  };
  const res = await esbuild.build({
    entryPoints: [file], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node20',
    sourcemap: 'external', sourcesContent: false, outdir: cacheDir, entryNames: '[name]', logLevel: 'silent', plugins: [plugin],
    // The SDK reads call sites from the stack; keep function names readable in traces.
    keepNames: true,
  });
  const js = res.outputFiles.find((f) => f.path.endsWith('.js'));
  const map = res.outputFiles.find((f) => f.path.endsWith('.map'));
  if (!js) throw new EzTestError(`esbuild produced no output for ${file}`, 'CODE_LOAD');
  const key = createHash('sha256').update(js.text).digest('hex').slice(0, 16);
  const name = `${slugify(basename(file)).slice(0, 40)}-${key}`;
  const out = join(cacheDir, `${name}.mjs`);
  if (!existsSync(out)) {
    await mkdir(cacheDir, { recursive: true });
    // Several processes (process workers, parallel test files) bundle the same file at once: each writes its
    // own temporary file and renames it into place, so no process ever imports a half-written module.
    const tmp = `${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(`${out}.map.${tmp}`, map?.text ?? '');
    await rename(`${out}.map.${tmp}`, `${out}.map`);
    await writeFile(`${out}.${tmp}`, `${js.text.replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n')}//# sourceMappingURL=${basename(out)}.map\n`);
    await rename(`${out}.${tmp}`, out);
  }
  if (map) {
    const m = JSON.parse(map.text) as { sources: string[]; mappings: string };
    shared().maps.set(out, decodeSourceMap(m, (s) => resolve(cacheDir, s)));
  }
  return { out, key };
}

function chooseLoader(file: string, esbuildAvailable: boolean): LoaderKind {
  if (/\.(?:m?js|cjs)$/i.test(file)) return 'js';
  const forced = process.env.EZTEST_CODE_LOADER;
  if (forced === 'esbuild') return 'esbuild';
  if (forced === 'native') return 'native';
  if (forced === 'tsx') return 'tsx-api';
  if (tsxActive()) return 'tsx-active';
  if (esbuildAvailable) return 'esbuild';
  if (nodeStripsTypes()) return 'native';
  return 'tsx-api';
}

async function load(file: string, o: LoadOptions): Promise<Loaded> {
  const abs = resolve(o.cwd ?? process.cwd(), file);
  if (!existsSync(abs)) throw new EzTestError(`Code file not found: ${abs}`, 'CODE_LOAD');
  const cwd = resolve(o.cwd ?? process.cwd());
  const s = shared();
  s.userFiles.add(abs);
  let esbuild: Esbuild | undefined;
  const wantEsbuild = !/\.(?:m?js|cjs)$/i.test(abs) && !tsxActive() && process.env.EZTEST_CODE_LOADER !== 'native' && process.env.EZTEST_CODE_LOADER !== 'tsx';
  if (wantEsbuild) esbuild = await optionalImport<Esbuild>('esbuild', cwd).then((m) => (m as unknown as { default?: Esbuild })?.default?.build ? (m as unknown as { default: Esbuild }).default : m);
  const loader = chooseLoader(abs, !!esbuild?.build);
  let url: string;
  let key: string;
  if (loader === 'esbuild') {
    if (!esbuild?.build) throw new EzTestError('EZTEST_CODE_LOADER=esbuild but esbuild is not installed', 'CODE_LOAD');
    const b = await bundle(esbuild, abs, cwd);
    url = pathToFileURL(b.out).href;
    key = `esbuild:${b.key}`;
  } else {
    const st = statSync(abs);
    key = `${loader}:${st.mtimeMs}:${st.size}`;
    url = `${pathToFileURL(abs).href}?v=${Math.round(st.mtimeMs)}`;
  }
  const hit = cache.get(abs);
  if (hit && hit.key === key) return hit;
  const seen = byUrl.get(url);
  if (seen && loader !== 'tsx-api') {
    const again: Loaded = { key, module: seen.module, registrations: seen.registrations, loader };
    cache.set(abs, again);
    return again;
  }
  s.registry.delete(abs);
  s.loading.push(abs);
  let module: Record<string, unknown>;
  try {
    if (loader === 'tsx-api') {
      const tsx = await optionalImport<{ tsImport(spec: string, parent: string): Promise<Record<string, unknown>> }>('tsx/esm/api', cwd);
      if (!tsx?.tsImport) {
        throw new EzTestError(
          `Cannot load TypeScript journey ${relative(cwd, abs) || abs}: install esbuild or tsx in the project ("npm install --save-dev esbuild"), ` +
            'run on Node 22.18+ (type stripping), or compile it to a .journey.js file.',
          'CODE_LOADER_MISSING',
        );
      }
      module = await tsx.tsImport(pathToFileURL(abs).href, import.meta.url);
    } else {
      module = (await import(url)) as Record<string, unknown>;
    }
  } catch (e) {
    if (e instanceof EzTestError) throw e;
    const err = e as Error;
    throw new EzTestError(`Could not load ${relative(cwd, abs) || abs} (${loader}): ${err.message.split('\n')[0]}`, 'CODE_LOAD');
  } finally {
    s.loading.pop();
  }
  const loaded: Loaded = { key, module, registrations: [...(s.registry.get(abs) ?? [])], loader };
  cache.set(abs, loaded);
  byUrl.set(url, { module, registrations: loaded.registrations });
  return loaded;
}

/** Load (or reuse) a code module. Concurrent loads of one file share the work. */
export async function loadCodeModule(file: string, o: LoadOptions = {}): Promise<Loaded> {
  const abs = resolve(o.cwd ?? process.cwd(), file);
  const pending = inflight.get(abs);
  if (pending) return pending;
  const p = load(abs, o).finally(() => inflight.delete(abs));
  inflight.set(abs, p);
  return p;
}

/** The journeys a `*.journey.ts` file declares, as Journey objects the runner, filters and reports understand. */
export async function loadCodeJourneys(file: string, o: LoadOptions = {}): Promise<Journey[]> {
  const cwd = resolve(o.cwd ?? process.cwd());
  const abs = resolve(cwd, file);
  const { registrations } = await loadCodeModule(abs, o);
  if (!registrations.length) throw new EzTestError(`${relative(cwd, abs) || abs} declares no journey (call journey("name", async (ctx) => { ... }) from @eztech.com/eztest/sdk)`, 'NO_JOURNEY');
  return registrations.map((r) => journeyFromRegistration(r, cwd));
}

export function journeyFromRegistration(r: Registration, cwd = process.cwd()): Journey {
  const o = r.options ?? {};
  const rel = relative(cwd, r.file) || r.file;
  const input: JourneyInput = {
    id: o.id ?? slugify(r.name),
    name: r.name,
    ...(o.description ? { description: o.description } : {}),
    tags: (o.tags ?? []).map((t) => t.replace(/^@/, '')),
    ...(o.role ? { role: o.role } : {}),
    ...(o.risk !== undefined ? { risk: o.risk } : {}),
    requirements: o.requirements ?? [],
    ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
    variables: o.variables ?? {},
    lenses: o.lenses ?? [],
    ...(o.emulation ? { emulation: o.emulation } : {}),
    ...(o.loaders ? { loaders: o.loaders } : {}),
    ...(o.examples ? { examples: o.examples } : {}),
    ...(o.examplesFrom ? { examplesFrom: o.examplesFrom } : {}),
    ...(o.params ? { params: o.params } : {}),
    ...(o.returns ? { returns: o.returns } : {}),
    ...(o.platform ? { platform: o.platform } : {}),
    ...(o.app ? { app: o.app } : {}),
    ...(o.capabilities ? { capabilities: o.capabilities } : {}),
    ...(o.actors ? { actors: Object.fromEntries(Object.entries(o.actors).map(([k, v]) => [k, typeof v === 'string' ? { role: v } : v])) } : {}),
    ...(o.browsers ? { browsers: o.browsers } : {}),
    code: { file: r.file, name: r.name, ...(r.line ? { line: r.line } : {}) },
    steps: [{
      id: 'code', intent: `Run code journey "${r.name}" (${rel}${r.line ? `:${r.line}` : ''})`, action: 'code', value: `${r.file}#journey:${r.name}`,
      ...(r.line ? { source: { file: r.file, line: r.line } } : {}),
    }],
  };
  return JourneySchema.parse(input);
}

/** What `Run code "file#name"` refers to: a registered journey or an exported function. */
export interface CodeTarget {
  file: string;
  kind: 'journey' | 'export';
  name: string;
  fn: (...args: never[]) => unknown;
}

/** Split "steps/billing.ts#settleOverdue" (default export when no #name). */
export function parseCodeRef(ref: string): { file: string; name: string; journey: boolean } {
  const i = ref.lastIndexOf('#');
  const file = i < 0 ? ref : ref.slice(0, i);
  const name = i < 0 ? 'default' : ref.slice(i + 1);
  const journey = name.startsWith('journey:');
  return { file: file.trim(), name: journey ? name.slice('journey:'.length) : name || 'default', journey };
}

/** Resolve and load a code reference relative to the given directories. */
export async function resolveCodeTarget(ref: string, dirs: string[], o: LoadOptions = {}): Promise<CodeTarget> {
  const { file, name, journey } = parseCodeRef(ref);
  if (!file) throw new EzTestError(`Run code needs a file: "${ref}"`, 'BAD_CODE_REF');
  const candidates = isAbsolute(file) ? [file] : dirs.map((d) => resolve(d, file));
  const withExt = candidates.flatMap((c) => (/\.(?:m?[jt]s)$/i.test(c) ? [c] : [c, `${c}.ts`, `${c}.js`]));
  const abs = withExt.find((c) => existsSync(c) && statSync(c).isFile());
  if (!abs) throw new EzTestError(`Run code: no file "${file}" (looked in ${dirs.join(', ')})`, 'BAD_CODE_REF');
  const loaded = await loadCodeModule(abs, o);
  if (journey) {
    const r = loaded.registrations.find((x) => x.name === name);
    if (!r) throw new EzTestError(`Run code: ${basename(abs)} declares no journey "${name}"`, 'BAD_CODE_REF');
    return { file: abs, kind: 'journey', name, fn: r.fn as CodeTarget['fn'] };
  }
  const v = loaded.module[name];
  if (typeof v !== 'function') {
    const reg = loaded.registrations.find((x) => x.name === name);
    if (reg) return { file: abs, kind: 'journey', name, fn: reg.fn as CodeTarget['fn'] };
    const fns = Object.entries(loaded.module).filter(([, x]) => typeof x === 'function').map(([k]) => k);
    throw new EzTestError(`Run code: ${basename(abs)} has no exported function "${name}" (exports: ${fns.join(', ') || 'none'})`, 'BAD_CODE_REF');
  }
  return { file: abs, kind: 'export', name, fn: v as CodeTarget['fn'] };
}

/** Forget loaded modules (tests, the Studio after edits). Bundles are content-addressed, so a changed file reloads anyway. */
export function clearCodeCache(): void {
  cache.clear();
}

/** Read a code file's text (for the Studio editor). */
export function readCodeFile(file: string): Promise<string> {
  return readFile(file, 'utf8');
}
