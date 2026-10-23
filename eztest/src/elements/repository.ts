/**
 * The shared element repository: named elements defined once and used by
 * every journey (Katalon's object repository, Tosca modules, UFT's object
 * repository, Ranorex's repository, TestComplete's name mapping).
 *
 * Sources, all loaded statically (nothing is executed):
 *  - `elements/*.yaml` (or .yml / .json): one screen per file
 *      screen: Checkout
 *      elements:
 *        placeOrder:
 *          description: the "Place order" button
 *          locators: [ 'role=button[name="Place order"]', testid=place-order ]
 *          aliases: [ the Checkout button ]
 *        emptyBasket: the "Empty basket" button          # a description, parsed like .ez
 *        total: testid=order-total or css=#total           # selectors, tried in order
 *  - TypeScript screens (`screen('Checkout', { placeOrder: { role: 'button', name: 'Place order' } })`,
 *    e.g. a `screens/` folder an importer wrote), read with the TypeScript compiler API;
 *    entries that are functions or computed values are skipped and reported.
 *
 * An element id is `<screen>.<key>` (`Checkout.placeOrder`). Journeys refer to
 * it as `the @Checkout.placeOrder button` / `@Checkout.placeOrder`, by its
 * description or an alias (`the Checkout button`), or from code through the
 * SDK's screen() (same id). The healer and the fingerprint store keep one
 * memory per element id (`@elements/<id>`), and accepting a heal in the
 * Quality Center rewrites the element here, which fixes every journey using it.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import YAML from 'yaml';
import { ElementFingerprint, LocatorCandidate, type Target } from '../core/index.js';
import { describeTarget } from '../intent/target.js';

export interface RepoElement {
  /** `<screen>.<key>`. */
  id: string;
  screen: string;
  key: string;
  /** Human description (reports, healing, description matching). */
  description: string;
  locators: LocatorCandidate[];
  fingerprint?: ElementFingerprint;
  frames?: string[];
  /** Other descriptions journeys may use for it (`the Checkout button`). */
  aliases: string[];
  /** Source file, relative to the project root. */
  file: string;
  /** 1-based line of the entry in its file, when known. */
  line?: number;
  source: 'yaml' | 'json' | 'screen';
}

export interface RepositoryProblem {
  file: string;
  message: string;
}

/** A screen id usable in `@Screen.key`: spaces and dots become `_`. */
export function screenId(name: string): string {
  return name.trim().replace(/[\s.]+/g, '_');
}

/** Normalised description used for matching: lower case, article and quotes dropped, spaces collapsed. */
export function normalizeDescription(d: string): string {
  return d.toLowerCase().replace(/[“”"'`]/g, '').replace(/^(?:the|a|an)\s+/, '').replace(/\s+/g, ' ').trim();
}

const SELECTOR_START = /^(?:xpath|css|text|testid|test-id|data-testid|role|id|accessibility\s*id|aid|class|predicate)\s*=|^\/\/|^\(\/\/|^[#.[]/i;

/** One locator written as a string (`role=button[name="Save"]`, `testid=x`, `#id`, `xpath=//...`). */
export function locatorFromString(s: string): LocatorCandidate {
  const t = describeTarget(s.trim());
  if (t.locators.length !== 1 || t.scope?.length || t.nth !== undefined || !SELECTOR_START.test(s.trim())) {
    throw new Error(`"${s}" is not a selector (use role=, testid=, css=, xpath=, text=, #id ...); describe the element in "description" instead`);
  }
  return t.locators[0];
}

/** A short-form entry: a description (`the "Save" button`) or selectors joined by " or ". */
function targetFromString(s: string): Target {
  const parts = s.split(/\s+or\s+(?=(?:xpath|css|text|testid|test-id|data-testid|role|id)\s*=|\/\/|#|\.)/i);
  if (parts.every((p) => SELECTOR_START.test(p.trim()))) {
    const locators = parts.map(locatorFromString);
    return { description: s, locators };
  }
  return describeTarget(s);
}

function asLocator(v: unknown, where: string): LocatorCandidate {
  if (typeof v === 'string') return locatorFromString(v);
  const r = LocatorCandidate.safeParse(v);
  if (!r.success) throw new Error(`${where}: invalid locator ${JSON.stringify(v)} (${r.error.issues[0]?.message ?? 'bad shape'})`);
  return r.data;
}

/** Parse one element entry of a YAML/JSON screen. */
export function elementFromEntry(screen: string, key: string, v: unknown, file: string, line?: number, source: RepoElement['source'] = 'yaml'): RepoElement {
  const id = `${screenId(screen)}.${key}`;
  if (!/^[A-Za-z_][\w-]*$/.test(key)) throw new Error(`element key "${key}" must be a word (letters, digits, _ and -)`);
  const base = { id, screen, key, file, ...(line ? { line } : {}), source };
  if (typeof v === 'string') {
    const t = targetFromString(v);
    if (!t.locators.length) throw new Error(`${id}: "${v}" gives no locator`);
    return { ...base, description: t.description, locators: t.locators, aliases: [] };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${id}: expected a description, selectors or an object with description and locators`);
  const o = v as Record<string, unknown>;
  const description = typeof o.description === 'string' && o.description.trim() ? o.description.trim() : `${key} (${screen})`;
  let locators: LocatorCandidate[] = [];
  const raw = o.locators ?? o.locator;
  if (raw !== undefined) locators = (Array.isArray(raw) ? raw : [raw]).map((x, i) => asLocator(x, `${id}.locators[${i}]`));
  else if (typeof o.description === 'string') locators = describeTarget(o.description).locators;
  if (!locators.length) throw new Error(`${id}: no locators (give "locators", or a description EZTest can turn into locators)`);
  let fingerprint: ElementFingerprint | undefined;
  if (o.fingerprint !== undefined) {
    const r = ElementFingerprint.safeParse(o.fingerprint);
    if (!r.success) throw new Error(`${id}: invalid fingerprint`);
    fingerprint = r.data;
  }
  const aliases = (Array.isArray(o.aliases) ? o.aliases : typeof o.aliases === 'string' ? [o.aliases] : []).map(String).filter(Boolean);
  const frames = Array.isArray(o.frames) ? o.frames.map(String) : undefined;
  return { ...base, description, locators, aliases, ...(fingerprint ? { fingerprint } : {}), ...(frames?.length ? { frames } : {}) };
}

/** Parse a YAML or JSON element file (`screen:` + `elements:`). */
export function parseElementFile(text: string, file: string): { elements: RepoElement[]; problems: RepositoryProblem[] } {
  const json = /\.json$/i.test(file);
  const problems: RepositoryProblem[] = [];
  const elements: RepoElement[] = [];
  let doc: YAML.Document | undefined;
  let data: unknown;
  try {
    if (json) data = JSON.parse(text);
    else {
      doc = YAML.parseDocument(text);
      if (doc.errors.length) throw new Error(doc.errors[0].message);
      data = doc.toJS();
    }
  } catch (e) {
    return { elements, problems: [{ file, message: `cannot read: ${(e as Error).message}` }] };
  }
  if (!data || typeof data !== 'object') return { elements, problems: [{ file, message: 'expected "screen:" and "elements:"' }] };
  const o = data as Record<string, unknown>;
  const screen = typeof o.screen === 'string' && o.screen.trim() ? o.screen.trim() : file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const els = o.elements;
  if (!els || typeof els !== 'object' || Array.isArray(els)) return { elements, problems: [{ file, message: '"elements" must be a map of name -> element' }] };
  const lineOf = (key: string): number | undefined => {
    if (!doc) return undefined;
    const node = (doc.get('elements', true) as YAML.YAMLMap | undefined)?.items?.find((p) => String((p.key as YAML.Scalar)?.value) === key);
    const off = (node?.key as YAML.Scalar | undefined)?.range?.[0];
    return off === undefined ? undefined : text.slice(0, off).split('\n').length;
  };
  for (const [key, v] of Object.entries(els as Record<string, unknown>)) {
    try {
      elements.push(elementFromEntry(screen, key, v, file, lineOf(key), json ? 'json' : 'yaml'));
    } catch (e) {
      problems.push({ file, message: (e as Error).message });
    }
  }
  return { elements, problems };
}

export interface LoadRepositoryOptions {
  /** Element directory (default `elements`), relative to `cwd`. */
  dir?: string;
  /** Directories of TypeScript screen modules read statically (e.g. `screens`). */
  screens?: string[];
  /** Match journey descriptions against element descriptions and aliases (default true). */
  matchDescriptions?: boolean;
}

async function filesUnder(dir: string, exts: RegExp): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const name of (await readdir(d)).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(d, name);
      if ((await stat(p)).isDirectory()) await walk(p);
      else if (exts.test(name)) out.push(p);
    }
  };
  await walk(dir);
  return out;
}

export class ElementRepository {
  private readonly byId = new Map<string, RepoElement>();
  private readonly byDesc = new Map<string, RepoElement[]>();
  readonly problems: RepositoryProblem[] = [];

  constructor(elements: RepoElement[] = [], readonly root = process.cwd(), readonly matchDescriptions = true) {
    for (const e of elements) this.add(e);
  }

  /** Load `elements/` (and TypeScript screens when asked) under a project root. */
  static async load(root: string, o: LoadRepositoryOptions = {}): Promise<ElementRepository> {
    const repo = new ElementRepository([], root, o.matchDescriptions ?? true);
    for (const f of await filesUnder(resolve(root, o.dir ?? 'elements'), /\.(?:ya?ml|json)$/i)) {
      const rel = relative(root, f).split('\\').join('/');
      const r = parseElementFile(await readFile(f, 'utf8'), rel);
      repo.problems.push(...r.problems);
      for (const e of r.elements) repo.add(e);
    }
    for (const dir of o.screens ?? []) {
      const { readScreenModule } = await import('./screens.js');
      for (const f of await filesUnder(resolve(root, dir), /\.(?:ts|mts|js|mjs)$/i)) {
        const rel = relative(root, f).split('\\').join('/');
        try {
          const r = await readScreenModule(await readFile(f, 'utf8'), rel);
          repo.problems.push(...r.problems);
          for (const e of r.elements) if (!repo.get(e.id)) repo.add(e);
        } catch (e) {
          repo.problems.push({ file: rel, message: (e as Error).message });
        }
      }
    }
    return repo;
  }

  private add(e: RepoElement): void {
    const prev = this.byId.get(e.id);
    if (prev) {
      this.problems.push({ file: e.file, message: `element ${e.id} is defined twice (${prev.file}${prev.line ? `:${prev.line}` : ''} and ${e.file}${e.line ? `:${e.line}` : ''}); the first one is used` });
      return;
    }
    this.byId.set(e.id, e);
    for (const d of [e.description, ...e.aliases]) {
      const k = normalizeDescription(d);
      if (!k) continue;
      this.byDesc.set(k, [...(this.byDesc.get(k) ?? []), e]);
    }
  }

  get size(): number {
    return this.byId.size;
  }

  get(id: string): RepoElement | undefined {
    return this.byId.get(id) ?? [...this.byId.values()].find((e) => e.id.toLowerCase() === id.toLowerCase());
  }

  list(): RepoElement[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The element a description names (description or alias), when exactly one does. */
  byDescription(description: string): RepoElement | undefined {
    if (!this.matchDescriptions) return undefined;
    const hits = this.byDesc.get(normalizeDescription(description));
    return hits?.length === 1 ? hits[0] : undefined;
  }
}
