/**
 * EZTest's own component / story harness. It mounts a component from the
 * project's bundler output in an isolated page, one story per URL, so plain
 * .ez journeys (with the visual and a11y lenses) can check a single component
 * in isolation — no Storybook test-runner, no Playwright component testing.
 *
 * It reads Storybook *story files* (Component Story Format) as input, since
 * reading a format is fine: the default export gives the title and shared
 * args, each named export is a story with its own args. Rendering is done by
 * a small renderer the project points at (its framework's mount), or the
 * built-in DOM renderer when a story's `render(args)` / `component(args)`
 * returns an HTMLElement or an HTML string.
 *
 * The story file and the renderer are the user's own code, so they are loaded
 * the one way EZTest loads user code: bundled with esbuild and evaluated in
 * the browser page (never `eval` in Node, never user code in the test
 * process). Args from the journey become URL query parameters.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EzTestError, slugify } from '../core/index.js';

export interface StoryRef {
  /** Stable id, e.g. "button--primary" (title slug + story slug). */
  id: string;
  /** Story export name, e.g. "Primary". */
  name: string;
  /** Component title, e.g. "Example/Button" -> "example-button". */
  title: string;
  titleId: string;
  file: string;
  /** Arg names the story or its meta declare (argTypes / args), for validation and the Studio gallery. */
  argNames: string[];
}

export interface StoryHarnessOptions {
  /** Story files (CSF). Absolute or relative to cwd. */
  files: string[];
  /** A renderer module exporting `mount(root, component, args)` and optional `unmount(root)`. Default: the built-in DOM renderer. */
  renderer?: string;
  cwd?: string;
  /** Extra <head> HTML (the app's CSS, design tokens). A list of file paths (inlined) or raw HTML. */
  head?: string[];
  host?: string;
}

type Esbuild = typeof import('esbuild');

async function loadEsbuild(cwd: string): Promise<Esbuild> {
  const { createRequire } = await import('node:module');
  for (const from of [resolve(cwd, 'noop.js'), import.meta.url]) {
    try {
      const req = createRequire(from);
      return (await import(pathToFileURL(req.resolve('esbuild')).href)) as Esbuild;
    } catch {
      /* try the next origin */
    }
  }
  throw new EzTestError('The component/story harness needs esbuild (install it in the project: npm i -D esbuild).', 'NO_ESBUILD');
}

/**
 * Statically read the metadata of a CSF story file: its default-export title
 * and the named story exports. Parsing the format is read-only (no user code
 * runs here); the actual component code runs only in the browser bundle.
 */
export function readStoryFile(source: string, file: string): { titleRaw?: string; stories: Array<{ name: string; argNames: string[] }> } {
  // title: from `title:` in the default export object.
  const titleRaw = /\btitle\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(source)?.[2];
  const exclude = new Set(['default', '__esModule']);
  // The component the meta points at (`component: Button`) is not itself a story.
  const comp = /\bcomponent\s*:\s*([A-Za-z_$][\w$]*)/.exec(source)?.[1];
  if (comp) exclude.add(comp);
  const stories: Array<{ name: string; argNames: string[] }> = [];
  const seen = new Set<string>();
  // Named exports that are stories: `export const Primary = ...`, `export function Primary(...)`, or `export { A, B }`.
  const add = (name: string, body: string) => {
    if (exclude.has(name) || seen.has(name) || !/^[A-Z]/.test(name)) return; // stories are PascalCase; meta helpers are not
    seen.add(name);
    const argBlock = /\bargs\s*:\s*\{([\s\S]*?)\}/.exec(body)?.[1] ?? '';
    const argNames = [...argBlock.matchAll(/(?:^|[,{])\s*(['"]?)([A-Za-z_$][\w$]*)\1\s*:/g)].map((m) => m[2]);
    stories.push({ name, argNames: [...new Set(argNames)] });
  };
  for (const m of source.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(\{[\s\S]*?\n\}|[^\n;]*)/g)) add(m[1], m[2]);
  for (const m of source.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)) add(m[1], '');
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) for (const part of m[1].split(',')) {
    const name = part.split(/\bas\b/).pop()!.trim();
    if (name) add(name, '');
  }
  return { ...(titleRaw ? { titleRaw } : {}), stories };
}

/** The in-browser mount runtime: reads the story from the bundled module, applies args, mounts via the renderer. */
const RUNTIME = `
import * as mod from '__EZ_STORY__';
import * as renderer from '__EZ_RENDERER__';
function domMount(root, component, args) {
  const out = typeof component === 'function' ? component(args) : component;
  if (out == null) throw new Error('story render returned nothing');
  if (typeof out === 'string') { root.innerHTML = out; return; }
  if (out instanceof Node) { root.appendChild(out); return; }
  throw new Error('the built-in DOM renderer needs a story render()/component that returns an HTMLElement or an HTML string; set components.harness.renderer for a framework renderer');
}
const mount = (renderer && renderer.mount) ? renderer.mount : domMount;
function getStory(name) {
  const s = mod[name];
  if (!s) throw new Error('no story "' + name + '" in this file (have: ' + Object.keys(mod).filter(k => k !== 'default').join(', ') + ')');
  return s;
}
function coerce(v) { try { return JSON.parse(v); } catch { return v; } }
async function run() {
  const url = new URL(location.href);
  const id = url.searchParams.get('story');
  const name = (__EZ_STORY_MAP__[id] || id);
  const root = document.getElementById('ez-root');
  try {
    const meta = mod.default || {};
    const story = getStory(name);
    const argsIn = {};
    for (const [k, v] of url.searchParams) { if (k !== 'story') argsIn[k] = coerce(v); }
    const args = Object.assign({}, meta.args, story.args, argsIn);
    const component = story.render || (typeof story === 'function' ? story : null) || story.component || meta.render || meta.component;
    if (!component) throw new Error('story "' + name + '" has no render/component (and the meta has none)');
    await mount(root, component, args, { story, meta });
    if (typeof story.play === 'function') { try { await story.play({ canvasElement: root, args }); } catch (e) { /* play errors surface via assertions */ } }
    root.setAttribute('data-ez-story-ready', '1');
    window.__ezStory = { ready: true, name, args };
  } catch (e) {
    root.setAttribute('data-ez-story-error', String(e && e.message || e));
    root.innerHTML = '<pre id="ez-story-error" style="color:#b00">' + String(e && e.message || e).replace(/[&<]/g, c => c === '&' ? '&amp;' : '&lt;') + '</pre>';
    window.__ezStory = { ready: false, error: String(e && e.message || e) };
  }
}
run();
`;

export class StoryHarness {
  private server?: Server;
  private readonly cwd: string;
  private readonly stories = new Map<string, StoryRef>();
  private readonly fileOf = new Map<string, string>(); // story file (abs) -> bundled JS
  private bundledHead = '';
  url = '';
  private esbuild?: Esbuild;

  constructor(private readonly opts: StoryHarnessOptions) {
    this.cwd = opts.cwd ?? process.cwd();
  }

  /** The stories discovered (after `start`). */
  list(): StoryRef[] {
    return [...this.stories.values()];
  }

  /** The URL of a story page, with args as query parameters. */
  urlFor(storyId: string, args: Record<string, unknown> = {}): string {
    if (!this.stories.has(storyId)) {
      const near = this.list().map((s) => s.id).filter((id) => id.includes(storyId) || storyId.includes(id)).slice(0, 3);
      throw new EzTestError(`no story "${storyId}"${near.length ? ` (did you mean ${near.join(', ')}?)` : ` (have ${this.list().map((s) => s.id).slice(0, 8).join(', ') || 'none'})`}`, 'NO_STORY');
    }
    const u = new URL(`${this.url}/story`);
    u.searchParams.set('story', storyId);
    for (const [k, v] of Object.entries(args)) u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    return u.href;
  }

  async start(): Promise<this> {
    this.esbuild = await loadEsbuild(this.cwd);
    const rendererPath = this.opts.renderer ? (isAbsolute(this.opts.renderer) ? this.opts.renderer : resolve(this.cwd, this.opts.renderer)) : undefined;
    for (const f of this.opts.files) {
      const abs = isAbsolute(f) ? f : resolve(this.cwd, f);
      const source = await readFile(abs, 'utf8');
      const meta = readStoryFile(source, abs);
      const titleRaw = meta.titleRaw ?? abs.replace(/\.stories\.[tj]sx?$/, '').split(/[\\/]/).pop()!;
      const titleId = titleRaw.split(/[\\/]/).map((p) => slugify(p)).join('-');
      if (!meta.stories.length) continue;
      const idMap: Record<string, string> = {};
      const refs: StoryRef[] = [];
      for (const s of meta.stories) {
        const id = `${titleId}--${slugify(s.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2'))}`;
        idMap[id] = s.name;
        refs.push({ id, name: s.name, title: titleRaw, titleId, file: abs, argNames: s.argNames });
      }
      const js = await this.bundle(abs, rendererPath, idMap);
      for (const r of refs) {
        this.stories.set(r.id, r);
        this.fileOf.set(r.id, js);
      }
    }
    if (!this.stories.size) throw new EzTestError(`No stories found in: ${this.opts.files.join(', ')} (a CSF file has a default export with a title and named story exports).`, 'NO_STORY');
    this.bundledHead = await this.buildHead();
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, this.opts.host ?? '127.0.0.1', r));
    this.url = `http://${this.opts.host ?? '127.0.0.1'}:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
  }

  private async bundle(storyFile: string, rendererPath: string | undefined, idMap: Record<string, string>): Promise<string> {
    const eb = this.esbuild!;
    const runtime = RUNTIME.replace("'__EZ_STORY__'", JSON.stringify(storyFile)).replace("'__EZ_RENDERER__'", JSON.stringify(rendererPath ?? storyFile));
    const result = await eb.build({
      stdin: { contents: runtime, resolveDir: dirname(storyFile), sourcefile: 'ez-story-entry.ts', loader: 'ts' },
      bundle: true, write: false, format: 'esm', platform: 'browser', sourcemap: 'inline', logLevel: 'silent',
      jsx: 'automatic', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"development"', __EZ_STORY_MAP__: JSON.stringify(idMap) },
    });
    const js = result.outputFiles?.find((o) => /\.js$/.test(o.path))?.text ?? result.outputFiles?.[0]?.text;
    if (!js) throw new EzTestError(`esbuild produced no output for ${storyFile}`, 'STORY_BUNDLE');
    return js;
  }

  private async buildHead(): Promise<string> {
    const parts: string[] = [];
    for (const h of this.opts.head ?? []) {
      const abs = isAbsolute(h) ? h : resolve(this.cwd, h);
      if (/\.css$/i.test(h)) {
        try {
          parts.push(`<style>${await readFile(abs, 'utf8')}</style>`);
          continue;
        } catch {
          /* not a file: treat as raw HTML */
        }
      }
      parts.push(h);
    }
    return parts.join('\n');
  }

  private page(storyId: string): string {
    const hash = createHash('sha1').update(storyId).digest('hex').slice(0, 8);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${storyId}</title>${this.bundledHead}
<style>body{margin:0;font-family:system-ui,sans-serif}#ez-root{padding:1rem}</style></head>
<body><div id="ez-root"></div><script type="module" src="/bundle/${storyId}.js?${hash}"></script></body></html>`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    if (url.pathname === '/story') {
      const id = url.searchParams.get('story') ?? '';
      if (!this.stories.has(id)) return void res.writeHead(404, { 'content-type': 'text/plain' }).end(`no story "${id}"`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(this.page(id));
      return;
    }
    const b = /^\/bundle\/(.+)\.js$/.exec(url.pathname);
    if (b) {
      const js = this.fileOf.get(b[1]);
      if (!js) return void res.writeHead(404).end('no bundle');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(js);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ stories: this.list() }, null, 2));
      return;
    }
    res.writeHead(404).end('not found');
  }
}

/** Load story metadata without starting a server (CLI listing, Studio gallery). */
export async function listStoryFiles(files: string[], cwd = process.cwd()): Promise<StoryRef[]> {
  const out: StoryRef[] = [];
  for (const f of files) {
    const abs = isAbsolute(f) ? f : resolve(cwd, f);
    const meta = readStoryFile(await readFile(abs, 'utf8'), abs);
    const titleRaw = meta.titleRaw ?? abs.replace(/\.stories\.[tj]sx?$/, '').split(/[\\/]/).pop()!;
    const titleId = titleRaw.split(/[\\/]/).map((p) => slugify(p)).join('-');
    for (const s of meta.stories) {
      out.push({ id: `${titleId}--${slugify(s.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2'))}`, name: s.name, title: titleRaw, titleId, file: abs, argNames: s.argNames });
    }
  }
  return out;
}
