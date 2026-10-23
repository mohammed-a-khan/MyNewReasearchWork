/**
 * What the language server knows about the project: the config (as written,
 * with source positions for roles and connections), journeys (by id and
 * name, with the line of their `Journey:` header), named queries and the
 * open documents (which win over the files on disk).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML, { LineCounter, isMap, isPair, isScalar, type Pair } from 'yaml';
import { slugify } from '../core/index.js';

export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface Location {
  uri: string;
  range: Range;
}

export const uriToPath = (uri: string): string => (uri.startsWith('file:') ? fileURLToPath(uri) : uri);
export const pathToUri = (p: string): string => pathToFileURL(p).href;

export const range = (line: number, from: number, to: number = from): Range => ({ start: { line, character: from }, end: { line, character: to } });

const CONFIG_FILES = ['eztest.config.yaml', 'eztest.config.yml', 'eztest.config.json'];
const JOURNEY_EXT = new Set(['.ez', '.yaml', '.yml', '.json']);
const SKIP = new Set(['node_modules', '.git', '.eztest', 'dist', 'eztest-results', 'test-results']);
const NOT_JOURNEY = /^(?:package(?:-lock)?\.json|tsconfig.*\.json|eztest\.config\.(?:ya?ml|json)|readiness-policy\.ya?ml|.*\.template\.ya?ml|.*\.locators\.json|masks\.json)$/i;

export interface JourneyInfo {
  uri: string;
  id: string;
  name: string;
  /** 0-based line of the `Journey:` (or `journey:`/`name:`) header. */
  nameLine: number;
  /** 0-based line of an explicit `Id:` header. */
  idLine?: number;
  explicitId: boolean;
}

export interface NamedDef {
  name: string;
  location: Location;
}

interface ConfigInfo {
  path?: string;
  raw: Record<string, unknown>;
  roles: NamedDef[];
  connections: NamedDef[];
  documents: NamedDef[];
  entities: NamedDef[];
}

function mapKeys(doc: YAML.Document, lc: LineCounter, uri: string, path: string[]): NamedDef[] {
  const node = doc.getIn(path, true);
  if (!isMap(node)) return [];
  return node.items.filter((p): p is Pair => isPair(p) && isScalar(p.key)).map((p) => {
    const k = p.key as YAML.Scalar;
    const [startOff, endOff] = k.range ?? [0, 0];
    const s = lc.linePos(startOff);
    const e = lc.linePos(endOff);
    return { name: String(k.value), location: { uri, range: { start: { line: s.line - 1, character: s.col - 1 }, end: { line: e.line - 1, character: e.col - 1 } } } };
  });
}

/** Header line of a journey text (journey name, id) without parsing the whole journey. */
export function journeyHeader(text: string, ext: string): { name?: string; id?: string; nameLine: number; idLine?: number } {
  const lines = text.split(/\r?\n/);
  let name: string | undefined;
  let id: string | undefined;
  let nameLine = 0;
  let idLine: number | undefined;
  const ez = ext === '.ez';
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (ez) {
      const m = /^(?:journey|name)\s*:\s*(.+)$/i.exec(t);
      if (m && name === undefined) {
        name = m[1].trim();
        nameLine = i;
      }
      const d = /^id\s*:\s*(.+)$/i.exec(t);
      if (d && id === undefined) {
        id = d[1].trim();
        idLine = i;
      }
    } else {
      const top = ext === '.json' ? /^\s{0,2}"(journey|name|id)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(lines[i]) : /^(journey|name|id)\s*:\s*['"]?(.*?)['"]?\s*$/.exec(lines[i]);
      if (!top) continue;
      if (top[1] === 'id') {
        if (id === undefined) {
          id = top[2];
          idLine = i;
        }
      } else if (name === undefined) {
        name = top[2];
        nameLine = i;
      }
    }
  }
  return { name, id, nameLine, idLine };
}

export class Workspace {
  readonly documents = new Map<string, string>();
  private configCache?: ConfigInfo;
  private journeyCache?: JourneyInfo[];
  private queryCache?: Map<string, string>;

  constructor(public root: string) {}

  invalidate(): void {
    this.configCache = undefined;
    this.journeyCache = undefined;
    this.queryCache = undefined;
  }

  /** Text of a document: the open buffer, else the file on disk. */
  text(uri: string): string | undefined {
    const open = this.documents.get(uri);
    if (open !== undefined) return open;
    const p = uriToPath(uri);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  }

  config(): ConfigInfo {
    if (this.configCache) return this.configCache;
    const path = CONFIG_FILES.map((f) => join(this.root, f)).find((f) => existsSync(f));
    const empty: ConfigInfo = { raw: {}, roles: [], connections: [], documents: [], entities: [] };
    if (!path) return (this.configCache = empty);
    const uri = pathToUri(path);
    try {
      const text = this.text(uri) ?? '';
      const lc = new LineCounter();
      const doc = YAML.parseDocument(text, { lineCounter: lc });
      const raw = (doc.toJS() ?? {}) as Record<string, unknown>;
      this.configCache = {
        path, raw,
        roles: mapKeys(doc, lc, uri, ['identity', 'roles']),
        connections: mapKeys(doc, lc, uri, ['db', 'connections']),
        documents: mapKeys(doc, lc, uri, ['documents']),
        entities: mapKeys(doc, lc, uri, ['data', 'entities']),
      };
    } catch {
      this.configCache = { ...empty, path };
    }
    return this.configCache;
  }

  journeysDir(): string {
    const d = this.config().raw.journeysDir;
    return resolve(this.root, typeof d === 'string' ? d : 'journeys');
  }

  queriesDir(): string {
    const q = (this.config().raw.db as { queries?: { dir?: unknown } } | undefined)?.queries?.dir;
    return resolve(this.root, typeof q === 'string' ? q : 'queries');
  }

  private walk(dir: string, accept: (p: string) => boolean, out: string[] = [], depth = 0): string[] {
    if (depth > 8 || !existsSync(dir)) return out;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return out;
    }
    for (const name of entries) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) this.walk(p, accept, out, depth + 1);
      else if (accept(p)) out.push(p);
    }
    return out;
  }

  /** Journeys of the workspace (journeysDir, else the root), plus open journey documents. */
  journeys(): JourneyInfo[] {
    if (this.journeyCache) return this.journeyCache;
    const dir = existsSync(this.journeysDir()) ? this.journeysDir() : this.root;
    const files = new Set(this.walk(dir, (p) => JOURNEY_EXT.has(extname(p).toLowerCase()) && !NOT_JOURNEY.test(p.split(/[\\/]/).pop() ?? '')).map(pathToUri));
    for (const uri of this.documents.keys()) if (JOURNEY_EXT.has(extname(uriToPath(uri)).toLowerCase())) files.add(uri);
    const out: JourneyInfo[] = [];
    for (const uri of files) {
      const text = this.text(uri);
      if (text === undefined) continue;
      const ext = extname(uriToPath(uri)).toLowerCase();
      const h = journeyHeader(text, ext);
      if (!h.name) continue;
      out.push({ uri, name: h.name, id: h.id ?? slugify(h.name), nameLine: h.nameLine, idLine: h.idLine, explicitId: h.id !== undefined });
    }
    return (this.journeyCache = out);
  }

  /** A journey by id, name or slug of its name. */
  findJourney(ref: string): JourneyInfo | undefined {
    const all = this.journeys();
    return all.find((j) => j.id === ref) ?? all.find((j) => j.name === ref) ?? all.find((j) => j.id === slugify(ref));
  }

  /** Named queries: NAME -> file path (NAME.sql under the queries directory). */
  queries(): Map<string, string> {
    if (this.queryCache) return this.queryCache;
    const m = new Map<string, string>();
    for (const f of this.walk(this.queriesDir(), (p) => extname(p).toLowerCase() === '.sql')) {
      const name = (f.split(/[\\/]/).pop() ?? '').replace(/\.sql$/i, '');
      if (!m.has(name)) m.set(name, f);
    }
    return (this.queryCache = m);
  }
}
