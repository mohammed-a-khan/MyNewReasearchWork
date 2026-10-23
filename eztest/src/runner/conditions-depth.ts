/**
 * Assertion depth: accessible name / description / role, aria snapshots
 * (partial, ordered matching against a YAML baseline, with an update mode),
 * negated text and value, and title / page-text patterns.
 *
 * Aria snapshot baselines: `file` is relative to the project (baseDir);
 * `name` is `.eztest/aria/<name>.aria.yml`. A missing baseline fails (with
 * the actual snapshot in the message) unless EZTEST_UPDATE_SNAPSHOTS=1
 * (`eztest run --update-snapshots`), which writes the actual snapshot and passes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Locator } from '../browser/index.js';
import type { Condition, ConditionResult } from '../core/index.js';
import { unifiedDiff } from '../heal/apply.js';
import type { ConditionEnv } from './conditions.js';
import { strictLocator } from './conditions-advanced.js';

type Depth = Extract<Condition, { type: 'accessible' | 'ariaSnapshot' | 'textNot' | 'pageMatches' }>;

const fail = (condition: Condition, message: string, actual?: string): ConditionResult => ({ condition, passed: false, message, ...(actual !== undefined ? { actual } : {}) });
const ok = (condition: Condition, actual?: string): ConditionResult => ({ condition, passed: true, ...(actual !== undefined ? { actual } : {}) });
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function isDepthCondition(c: Condition): c is Depth {
  return c.type === 'accessible' || c.type === 'ariaSnapshot' || c.type === 'textNot' || c.type === 'pageMatches';
}

export async function evaluateDepthCondition(c: Depth, env: ConditionEnv): Promise<ConditionResult> {
  const I = env.interpolate;
  switch (c.type) {
    case 'accessible': {
      const r = await strictLocator(env, c.target);
      if (!r.locator) return fail(c, `${c.target.description}: not found exactly once (${r.notes.join('; ')})`);
      const actual = await accessibleProperty(r.locator, c.property);
      const want = I(c.value);
      const pass = c.op === 'equals' ? norm(actual) === norm(want)
        : c.op === 'ne' ? norm(actual) !== norm(want)
          : c.op === 'contains' ? norm(actual).toLowerCase().includes(norm(want).toLowerCase())
            : new RegExp(want).test(actual);
      const label = c.property === 'role' ? 'role' : `accessible ${c.property}`;
      return pass ? ok(c, actual) : fail(c, `${c.target.description} ${label} is "${actual}", expected to ${c.op === 'ne' ? 'differ from' : c.op === 'equals' ? 'be' : c.op === 'contains' ? 'contain' : 'match'} "${want}"`, actual);
    }
    case 'textNot': {
      const r = await strictLocator(env, c.target);
      if (!r.locator) return fail(c, `${c.target.description}: not found exactly once (${r.notes.join('; ')})`);
      const actual = c.field === 'value' ? await r.locator.inputValue({ timeout: 2000 }) : norm(await r.locator.innerText({ timeout: 2000 }));
      const bad = norm(I(c.value));
      const hit = c.mode === 'contains' ? (bad ? norm(actual).includes(bad) : true) : norm(actual) === bad;
      return hit ? fail(c, `${c.target.description} ${c.field} "${actual}" ${c.mode === 'contains' ? 'contains' : 'is'} "${bad}"`, actual) : ok(c, actual);
    }
    case 'pageMatches': {
      const text = c.what === 'title' ? await env.page.title() : norm(await env.page.locator('body').innerText({ timeout: 2000 }).catch(() => ''));
      const re = new RegExp(I(c.pattern), c.flags);
      const hit = re.test(text);
      const what = c.what === 'title' ? 'title' : 'page text';
      if (c.negate) return hit ? fail(c, `${what} matches /${re.source}/`, text.slice(0, 300)) : ok(c);
      return hit ? ok(c, text.slice(0, 300)) : fail(c, `${what} does not match /${re.source}/`, text.slice(0, 300));
    }
    case 'ariaSnapshot':
      return ariaSnapshotCondition(c, env);
  }
}

/** Computed by EZTest's page engine (accname 1.2, HTML-AAM roles); no page script runs. */
function accessibleProperty(loc: Locator, p: 'name' | 'description' | 'role'): Promise<string> {
  const o = { timeout: 2000 };
  return p === 'name' ? loc.accessibleName(o) : p === 'description' ? loc.accessibleDescription(o) : loc.ariaRole(o);
}

// ------------------------------------------------------------------ aria snapshots

export interface AriaNode {
  role: string;
  name?: string | { regex: string; flags?: string };
  attrs: Record<string, string>;
  children: AriaNode[];
  line: string;
}

function parseName(raw: string | undefined): AriaNode['name'] {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  const re = /^\/(.*)\/([gimsuy]*)$/.exec(t);
  if (re) return { regex: re[1], ...(re[2] ? { flags: re[2] } : {}) };
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

/** Parse an aria snapshot (`- role "name" [attr=v]`, two spaces per level; `role "name":` and `- text: x` accepted). */
export function parseAriaSnapshot(text: string): AriaNode[] {
  const roots: AriaNode[] = [];
  const stack: Array<{ indent: number; node: AriaNode }> = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const m = /^(\s*)-\s+(.*?)\s*$/.exec(raw);
    if (!m) throw new Error(`Cannot read the aria snapshot line "${raw.trim()}" (expected "- role \\"name\\"")`);
    const indent = m[1].length;
    let body = m[2].replace(/:$/, '');
    let name: string | undefined;
    // "- text: Hello" / "- text "Hello""
    const textColon = /^text:\s*(.*)$/.exec(m[2]);
    if (textColon) {
      body = 'text';
      name = JSON.stringify(textColon[1].replace(/^"(.*)"$/, '$1'));
    }
    const attrs: Record<string, string> = {};
    body = body.replace(/\s*\[([\w-]+)(?:=([^\]]*))?\]/g, (_w, k: string, v?: string) => {
      attrs[k] = v ?? 'true';
      return '';
    });
    const rm = /^([a-z][\w-]*)(?:\s+("(?:[^"\\]|\\.)*"|\/(?:[^/\\]|\\.)*\/[a-z]*))?\s*$/i.exec(body.trim());
    if (!rm) throw new Error(`Cannot read the aria snapshot line "${raw.trim()}"`);
    const node: AriaNode = { role: rm[1].toLowerCase(), name: parseName(name ?? rm[2]), attrs, children: [], line: raw.trim() };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ indent, node });
  }
  return roots;
}

function nameMatches(want: AriaNode['name'], got: AriaNode['name'], isText: boolean): boolean {
  if (want === undefined) return true;
  const g = typeof got === 'string' ? got : '';
  if (typeof want === 'object') return new RegExp(want.regex, want.flags).test(g);
  return isText ? norm(g).includes(norm(want)) : norm(g) === norm(want);
}

function nodeMatches(want: AriaNode, got: AriaNode): boolean {
  if (want.role !== got.role) return false;
  if (!nameMatches(want.name, got.name, want.role === 'text')) return false;
  return Object.entries(want.attrs).every(([k, v]) => got.attrs[k] === v);
}

/** Pre-order list of a forest with subtree sizes. */
function flatten(nodes: AriaNode[]): Array<{ node: AriaNode; size: number }> {
  const out: Array<{ node: AriaNode; size: number }> = [];
  const walk = (n: AriaNode) => {
    const at = out.length;
    out.push({ node: n, size: 0 });
    n.children.forEach(walk);
    out[at].size = out.length - at - 1;
  };
  nodes.forEach(walk);
  return out;
}

/**
 * Partial, ordered match: every template node must match an actual node that
 * comes after the previous sibling's match, and its children must match inside
 * that node's subtree. Returns the first template line that could not be matched.
 */
export function matchAriaSnapshot(template: AriaNode[], actual: AriaNode[]): { ok: true } | { ok: false; missing: string } {
  const flat = flatten(actual);
  const matchList = (want: AriaNode[], from: number, to: number): { ok: true } | { ok: false; missing: string } => {
    let i = from;
    for (const w of want) {
      let found = -1;
      let firstMissing: string | undefined;
      for (let k = i; k < to; k++) {
        if (!nodeMatches(w, flat[k].node)) continue;
        const inner = matchList(w.children, k + 1, k + 1 + flat[k].size);
        if (inner.ok) {
          found = k;
          break;
        }
        firstMissing ??= inner.missing;
      }
      if (found < 0) return { ok: false, missing: firstMissing ?? w.line };
      i = found + flat[found].size + 1;
    }
    return { ok: true };
  };
  return matchList(template, 0, flat.length);
}

function baselinePath(c: Extract<Condition, { type: 'ariaSnapshot' }>, env: ConditionEnv): string | undefined {
  const base = env.baseDir ?? process.cwd();
  if (c.file) {
    const f = env.interpolate(c.file);
    return isAbsolute(f) ? f : resolve(base, f);
  }
  if (c.name) return resolve(base, '.eztest', 'aria', `${env.interpolate(c.name).replace(/[^\w.-]+/g, '_')}.aria.yml`);
  return undefined;
}

async function ariaSnapshotCondition(c: Extract<Condition, { type: 'ariaSnapshot' }>, env: ConditionEnv): Promise<ConditionResult> {
  let loc: Locator;
  if (c.target) {
    const r = await strictLocator(env, c.target);
    if (!r.locator) return fail(c, `${c.target.description}: not found exactly once (${r.notes.join('; ')})`);
    loc = r.locator;
  } else loc = env.page.locator('body');
  const actualText = await loc.ariaSnapshot({ timeout: 2000 });
  const file = baselinePath(c, env);
  const update = process.env.EZTEST_UPDATE_SNAPSHOTS === '1';
  let templateText = c.snapshot;
  if (templateText === undefined) {
    if (!file) return fail(c, 'aria snapshot condition needs a snapshot, a file or a name');
    if (update) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${actualText.trimEnd()}\n`);
      return ok(c, `baseline written: ${file}`);
    }
    if (!existsSync(file)) return fail(c, `no aria snapshot baseline ${file} yet: run with --update-snapshots to write it. Actual:\n${actualText}`, actualText);
    templateText = readFileSync(file, 'utf8');
  }
  let template: AriaNode[];
  try {
    template = parseAriaSnapshot(templateText);
  } catch (e) {
    return fail(c, (e as Error).message);
  }
  if (!template.length) return fail(c, 'the aria snapshot is empty; nothing would be checked');
  const r = matchAriaSnapshot(template, parseAriaSnapshot(actualText));
  if (r.ok) return ok(c, actualText);
  const diff = unifiedDiff(templateText.trimEnd(), actualText.trimEnd(), 2).map((l) => `${l.kind}${l.text}`).join('\n');
  return fail(c, `${c.target?.description ?? 'the page'} does not match the aria snapshot${file ? ` ${file}` : ''}: missing ${r.missing}\n${diff}`, actualText);
}
