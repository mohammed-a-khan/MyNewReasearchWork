/**
 * UI coverage map: which pages (routes) and interactive elements (by
 * accessible role and name) exist in the application, as seen in the
 * time-travel trace snapshots of runs, and which of them the journeys
 * actually interacted with or asserted on.
 *
 * - Pages are grouped by route template (`/orders/:id`): numeric, UUID and
 *   hash-like path segments become `:id`, or `coverage.ui.routes` patterns.
 * - Elements are grouped per page by role + accessible name (numbers in names
 *   normalised, so "ORD-12" and "ORD-13" links are one element group).
 * - An element is *interacted* when a step acted on it (the trace records the
 *   target's node id in the step's before-snapshot) and *asserted* when a
 *   post-condition or assertion targets it (matched by the step's locators).
 * - Links whose target route never appears as a visited page are listed as
 *   unvisited links.
 *
 * Deterministic and offline: snapshots are tokenized, never rendered or run.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Journey, LocatorCandidate, Step, Target } from '../core/index.js';
import { EvidenceVault, flattenSteps } from '../core/index.js';
import { listTraces, readSnapshotHtml, readTrace, runDirSource } from '../runner/trace/read.js';
import type { SnapshotRef, TraceFile } from '../runner/trace/types.js';
import { interactiveElements, type ParsedSnapshot, type SnapshotElement } from './snapshot-dom.js';

export const UI_COVERAGE_FILE = 'ui-coverage.json';

export interface UiCoverageOptions {
  /** Route patterns (`/orders/:id`, `/customers/:cid/orders/*`) matched before the automatic template. */
  routes?: string[];
  /** Group element names that differ only in numbers ("ORD-12", "ORD-13"). Default true. */
  normalizeNumbers?: boolean;
  /** Elements to leave out: `role` or `role:name` (case-insensitive, `*` wildcard), e.g. "link:Skip to content". */
  ignore?: string[];
  /** Routes to leave out (patterns as in `routes`, `*` wildcard), e.g. "/logout". */
  ignoreRoutes?: string[];
  /** Attribute used for test ids (default data-testid). */
  testIdAttribute?: string;
}

export interface UiElementCoverage {
  /** `role|normalised name` (unique within its page). */
  key: string;
  role: string;
  /** Display name (first one seen). */
  name: string;
  /** Name, or an identifying fallback (#id, testid=..., [name=...]) for unnamed elements. */
  label: string;
  tag: string;
  /** Largest number of matching elements in one snapshot (a group of similar elements). */
  count: number;
  disabled?: boolean;
  /** For links: the target route template. */
  href?: string;
  interactions: number;
  assertions: number;
  /** Journeys that interacted with or asserted on the element. */
  journeys: string[];
  tested: boolean;
}

export interface UiSnapshotPointer {
  runId: string;
  journeyId: string;
  attempt: number;
  /** Position of the step in the trace. */
  step: number;
  phase: 'before' | 'after';
  /** Run-relative path of the snapshot file. */
  path: string;
  url: string;
}

export interface UiPageCoverage {
  route: string;
  /** An example URL (masked as in the trace). */
  url: string;
  title: string;
  /** Snapshots seen on this route. */
  snapshots: number;
  journeys: string[];
  elements: UiElementCoverage[];
  total: number;
  tested: number;
  percent: number;
  /** The snapshot with the most elements, for the heat overlay. */
  representative?: UiSnapshotPointer;
}

export interface UiCoverageReport {
  version: 1;
  runIds: string[];
  generatedAt: string;
  pages: UiPageCoverage[];
  totals: { pages: number; elements: number; tested: number; percent: number; links: number; visitedLinks: number; snapshots: number };
  /** Links (route templates) that no journey visited. */
  unvisitedLinks: Array<{ route: string; from: string[]; label: string }>;
  journeys: Array<{ journeyId: string; pages: number; elements: number }>;
  warnings: string[];
}

// ------------------------------------------------------------------ routes

const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|[A-Za-z]{0,6}[-_]?\d{3,}[A-Za-z0-9-]*)$/i;

function patternRe(p: string): RegExp {
  const esc = p.replace(/\/+$/, '').split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg === '*' ? '[^/]+' : seg === '**' ? '.*' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${esc || ''}/?$`, 'i');
}

/** Route template of a URL path: a configured pattern, else id-like segments as `:id`. */
export function routeTemplate(url: string, opts: Pick<UiCoverageOptions, 'routes'> = {}): string {
  let path: string;
  let hashRoute = '';
  try {
    const u = new URL(url);
    path = u.pathname || '/';
    if (u.hash.startsWith('#/')) hashRoute = u.hash.slice(1).split('?')[0];
  } catch {
    path = url.split(/[?#]/)[0] || '/';
  }
  const full = hashRoute ? `${path.replace(/\/$/, '')}#${hashRoute}` : path;
  for (const p of opts.routes ?? []) if (patternRe(p).test(hashRoute ? hashRoute : path)) return hashRoute ? `${path.replace(/\/$/, '')}#${p}` : p;
  const tpl = (s: string) => s.split('/').map((seg) => (seg && ID_SEGMENT.test(decodeURIComponent(seg)) ? ':id' : seg)).join('/') || '/';
  return hashRoute ? `${tpl(path).replace(/\/$/, '')}#${tpl(hashRoute)}` : tpl(full);
}

function wild(p: string): RegExp {
  return new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
}

// ------------------------------------------------------------------ elements

const norm = (s: string, numbers: boolean) => {
  const t = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return numbers ? t.replace(/\d+(?:[.,]\d+)*/g, '#') : t;
};

function labelOf(e: SnapshotElement): string {
  if (e.name) return e.name;
  if (e.testId) return `testid=${e.testId}`;
  if (e.id) return `#${e.id}`;
  if (e.nameAttr) return `[name="${e.nameAttr}"]`;
  return `(unnamed ${e.role})`;
}

function keyOf(e: SnapshotElement, numbers: boolean): string {
  return `${e.role}|${norm(labelOf(e), numbers)}`;
}

/** Does a locator candidate (or a target) point at this element? */
export function candidateMatches(c: LocatorCandidate, e: SnapshotElement): boolean {
  const v = c.value.trim().toLowerCase();
  const name = e.name.toLowerCase();
  const eq = (a: string) => (c.exact ? a === v : a === v || (v.length >= 3 && a.includes(v)));
  switch (c.strategy) {
    case 'role': {
      if (c.value.toLowerCase() !== e.role) return false;
      if (!c.name) return true;
      const n = c.name.trim().toLowerCase();
      return c.exact ? name === n : name === n || (n.length >= 3 && name.includes(n));
    }
    case 'label': case 'placeholder': case 'title': case 'altText': return eq(name);
    case 'text': return eq(name);
    case 'testId': return (e.testId ?? '').toLowerCase() === v;
    case 'css': {
      const id = /^#([\w-]+)$/.exec(c.value.trim());
      if (id) return e.id === id[1];
      const tid = /^\[data-testid=["']?([^"'\]]+)["']?\]$/.exec(c.value.trim());
      if (tid) return e.testId === tid[1];
      const nm = /^(?:[a-z]+)?\[name=["']?([^"'\]]+)["']?\]$/i.exec(c.value.trim());
      return nm ? e.nameAttr === nm[1] : false;
    }
    default: return false;
  }
}

function targetMatches(t: Target, e: SnapshotElement): boolean {
  return t.locators.some((c) => !c.value.includes('${') && candidateMatches(c, e));
}

/** Targets a step asserts on: its post-conditions and (for assert steps) its own target. */
function assertedTargets(s: Step): Target[] {
  const out: Target[] = [];
  for (const c of s.postconditions) if ('target' in c && c.target) out.push(c.target as Target);
  if (s.action === 'assert' && s.target) out.push(s.target);
  return out;
}

// ------------------------------------------------------------------ computation

interface PageAcc {
  route: string;
  url: string;
  title: string;
  snapshots: number;
  journeys: Set<string>;
  elements: Map<string, UiElementCoverage & { journeySet: Set<string> }>;
  best?: { pointer: UiSnapshotPointer; n: number };
}

export interface TraceInput {
  runId: string;
  trace: TraceFile;
  /** Loads a snapshot's raw HTML. */
  read(ref: SnapshotRef): Promise<string>;
}

/** Build the coverage map from traces (one or more runs). `journeys` adds assertion targets from the journey definitions. */
export async function computeUiCoverage(traces: TraceInput[], journeys: Journey[] = [], opts: UiCoverageOptions = {}): Promise<UiCoverageReport> {
  const numbers = opts.normalizeNumbers !== false;
  const ignore = (opts.ignore ?? []).map((p) => {
    const [role, ...name] = p.split(':');
    return { role: wild(role.trim() || '*'), name: name.length ? wild(name.join(':').trim().toLowerCase()) : undefined };
  });
  const ignoredRoute = (r: string) => (opts.ignoreRoutes ?? []).some((p) => patternRe(p).test(r) || wild(p).test(r));
  const isIgnored = (e: SnapshotElement) => ignore.some((i) => i.role.test(e.role) && (!i.name || i.name.test(e.name.toLowerCase())));
  const steps = new Map<string, Map<string, Step>>();
  for (const j of journeys) steps.set(j.id, new Map(flattenSteps(j.steps).map((s) => [s.id, s])));
  // Examples rows run as "<id>-<row>" journeys: fall back to the base journey's steps.
  const stepsOf = (journeyId: string) => steps.get(journeyId) ?? [...steps.entries()].find(([id]) => journeyId.startsWith(`${id}-`))?.[1];
  const pages = new Map<string, PageAcc>();
  const hosts = new Map<string, number>();
  const warnings: string[] = [];
  const parsed = new Map<string, ParsedSnapshot>();
  const runIds = new Set<string>();
  let snapshotCount = 0;
  const hostOf = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  };
  for (const t of traces) for (const s of t.trace.steps) for (const ref of [s.snapshots.before, s.snapshots.after]) if (ref?.engine === 'in-page') hosts.set(hostOf(ref.url), (hosts.get(hostOf(ref.url)) ?? 0) + 1);
  const primary = [...hosts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const pageKey = (url: string) => {
    const r = routeTemplate(url, opts);
    const h = hostOf(url);
    return h && h !== primary ? `//${h}${r}` : r;
  };
  const load = async (t: TraceInput, ref: SnapshotRef): Promise<ParsedSnapshot | undefined> => {
    const k = `${t.runId}/${ref.path}`;
    if (parsed.has(k)) return parsed.get(k);
    try {
      const p = interactiveElements(await t.read(ref), { testIdAttribute: opts.testIdAttribute });
      parsed.set(k, p);
      return p;
    } catch (e) {
      warnings.push(`snapshot ${ref.path} of ${t.runId} could not be read: ${(e as Error).message}`);
      parsed.set(k, undefined as never);
      return undefined;
    }
  };
  const pageFor = (url: string, title: string): PageAcc => {
    const key = pageKey(url);
    let p = pages.get(key);
    if (!p) {
      p = { route: key, url, title, snapshots: 0, journeys: new Set(), elements: new Map() };
      pages.set(key, p);
    }
    return p;
  };
  const visited = new Set<string>();
  const linkSources = new Map<string, { from: Set<string>; label: string }>();
  for (const t of traces) {
    runIds.add(t.runId);
    const jid = t.trace.journeyId;
    const defs = stepsOf(jid);
    for (const [pos, s] of t.trace.steps.entries()) {
      for (const phase of ['before', 'after'] as const) {
        const ref = s.snapshots[phase];
        if (!ref || ref.engine !== 'in-page') continue;
        const route = pageKey(ref.url);
        if (ignoredRoute(route)) continue;
        visited.add(route);
        const snap = await load(t, ref);
        if (!snap) continue;
        snapshotCount++;
        const page = pageFor(ref.url, ref.title);
        page.snapshots++;
        page.journeys.add(jid);
        const counts = new Map<string, number>();
        for (const e of snap.elements) {
          if (isIgnored(e)) continue;
          const key = keyOf(e, numbers);
          counts.set(key, (counts.get(key) ?? 0) + 1);
          let el = page.elements.get(key);
          if (!el) {
            el = {
              key, role: e.role, name: e.name, label: labelOf(e), tag: e.tag, count: 0, interactions: 0, assertions: 0, journeys: [], tested: false, journeySet: new Set(),
              ...(e.disabled ? { disabled: true } : {}),
            };
            page.elements.set(key, el);
          }
          if (!e.disabled) delete el.disabled;
          if (e.role === 'link' && e.href && !el.href) {
            try {
              const abs = new URL(e.href, ref.url);
              if (/^https?:$/.test(abs.protocol)) {
                el.href = pageKey(abs.toString());
                const ls = linkSources.get(el.href) ?? { from: new Set<string>(), label: el.label };
                ls.from.add(route);
                linkSources.set(el.href, ls);
              }
            } catch {
              // not a URL
            }
          }
        }
        for (const [k, n] of counts) {
          const el = page.elements.get(k)!;
          el.count = Math.max(el.count, n);
        }
        const n = snap.elements.length;
        if (!page.best || n > page.best.n || (n === page.best.n && phase === 'after')) {
          page.best = { n, pointer: { runId: t.runId, journeyId: jid, attempt: t.trace.attempt, step: pos, phase, path: ref.path, url: ref.url } };
        }
      }
      // Interaction: the element the step acted on (node id of its target in the before-snapshot).
      const before = s.snapshots.before;
      const def = defs?.get(s.stepId);
      const acted = new Set<string>();
      if (before?.engine === 'in-page' && before.target && !['assert', 'capture', 'wait', 'query'].includes(s.action)) {
        const snap = await load(t, before);
        const owner = snap?.owner(before.target.nid);
        const e = owner !== undefined ? snap!.elements.find((x) => x.nid === owner) : undefined;
        const route = pageKey(before.url);
        const el = e && !isIgnored(e) ? pages.get(route)?.elements.get(keyOf(e, numbers)) : undefined;
        if (el) {
          el.interactions++;
          el.journeySet.add(jid);
          acted.add(el.key);
        }
      }
      // A step without a recorded node id (e.g. the target resolved in a frame) still counts through its locators.
      if (!acted.size && def?.target && s.locator.used && !['assert', 'capture', 'wait', 'query'].includes(s.action)) {
        const ref = s.snapshots.before ?? s.snapshots.after;
        const page = ref ? pages.get(pageKey(ref.url)) : undefined;
        const snap = ref ? await load(t, ref) : undefined;
        const hit = snap?.elements.find((x) => candidateMatches(s.locator.used!, x) && !isIgnored(x));
        const el = hit ? page?.elements.get(keyOf(hit, numbers)) : undefined;
        if (el) {
          el.interactions++;
          el.journeySet.add(jid);
        }
      }
      // Assertions: post-condition / assert targets, matched on the after-snapshot (else before).
      if (def) {
        const ref = s.snapshots.after ?? s.snapshots.before;
        if (!ref || ref.engine !== 'in-page') continue;
        const snap = await load(t, ref);
        const page = pages.get(pageKey(ref.url));
        if (!snap || !page) continue;
        for (const target of assertedTargets(def)) {
          const hits = snap.elements.filter((x) => targetMatches(target, x) && !isIgnored(x));
          for (const k of new Set(hits.map((x) => keyOf(x, numbers)))) {
            const el = page.elements.get(k);
            if (!el) continue;
            el.assertions++;
            el.journeySet.add(jid);
          }
        }
      }
    }
  }
  const outPages: UiPageCoverage[] = [...pages.values()].map((p) => {
    const elements = [...p.elements.values()].map(({ journeySet, ...e }) => ({ ...e, journeys: [...journeySet].sort(), tested: e.interactions + e.assertions > 0 }))
      .sort((a, b) => Number(a.tested) - Number(b.tested) || a.role.localeCompare(b.role) || a.label.localeCompare(b.label));
    const tested = elements.filter((e) => e.tested).length;
    return {
      route: p.route, url: p.url, title: p.title, snapshots: p.snapshots, journeys: [...p.journeys].sort(), elements, total: elements.length, tested,
      percent: elements.length ? tested / elements.length : 0, ...(p.best ? { representative: p.best.pointer } : {}),
    };
  }).sort((a, b) => a.route.localeCompare(b.route));
  const total = outPages.reduce((n, p) => n + p.total, 0);
  const tested = outPages.reduce((n, p) => n + p.tested, 0);
  const unvisitedLinks = [...linkSources.entries()].filter(([r]) => !visited.has(r) && !ignoredRoute(r) && !r.startsWith('//'))
    .map(([route, v]) => ({ route, from: [...v.from].sort(), label: v.label })).sort((a, b) => a.route.localeCompare(b.route));
  const byJourney = new Map<string, { pages: Set<string>; elements: number }>();
  for (const p of outPages) {
    for (const j of p.journeys) (byJourney.get(j) ?? byJourney.set(j, { pages: new Set(), elements: 0 }).get(j)!).pages.add(p.route);
    for (const e of p.elements) for (const j of e.journeys) (byJourney.get(j) ?? byJourney.set(j, { pages: new Set(), elements: 0 }).get(j)!).elements++;
  }
  if (!traces.length) warnings.push('No time-travel traces found: enable trace.timeTravel (or run with --time-travel) so runs record DOM snapshots.');
  return {
    version: 1,
    runIds: [...runIds].sort(),
    generatedAt: new Date().toISOString(),
    pages: outPages,
    totals: {
      pages: outPages.length, elements: total, tested, percent: total ? tested / total : 0,
      links: linkSources.size, visitedLinks: [...linkSources.keys()].filter((r) => visited.has(r)).length, snapshots: snapshotCount,
    },
    unvisitedLinks,
    journeys: [...byJourney.entries()].map(([journeyId, v]) => ({ journeyId, pages: v.pages.size, elements: v.elements })).sort((a, b) => a.journeyId.localeCompare(b.journeyId)),
    warnings,
  };
}

/** The traces of a run directory as coverage inputs (last attempt of each journey). */
export async function runTraceInputs(runDir: string, runId: string): Promise<TraceInput[]> {
  const list = await listTraces(runDir);
  const last = new Map<string, number>();
  for (const t of list) last.set(t.journeyId, Math.max(last.get(t.journeyId) ?? 0, t.attempt));
  const src = runDirSource(runDir);
  const out: TraceInput[] = [];
  for (const [journeyId, attempt] of last) {
    try {
      const trace = await readTrace(runDir, journeyId, attempt);
      out.push({ runId, trace, read: (ref) => readSnapshotHtml(src, ref) });
    } catch {
      // not readable: skipped
    }
  }
  return out;
}

/** UI coverage of one run. */
export async function computeRunUiCoverage(runDir: string, runId: string, journeys: Journey[] = [], opts: UiCoverageOptions = {}): Promise<UiCoverageReport> {
  return computeUiCoverage(await runTraceInputs(runDir, runId), journeys, opts);
}

/** UI coverage over several runs (e.g. the latest run of every journey). */
export async function computeUiCoverageOverRuns(runs: Array<{ runDir: string; runId: string }>, journeys: Journey[] = [], opts: UiCoverageOptions = {}): Promise<UiCoverageReport> {
  const inputs: TraceInput[] = [];
  for (const r of runs) inputs.push(...(await runTraceInputs(r.runDir, r.runId)));
  return computeUiCoverage(inputs, journeys, opts);
}

/** Compute and write `ui-coverage.json`, recorded in the run's evidence chain (readiness cites it). */
export async function recordUiCoverage(runDir: string, runId: string, journeys: Journey[] = [], opts: UiCoverageOptions = {}): Promise<{ report: UiCoverageReport; evidenceId?: string } | undefined> {
  const report = await computeRunUiCoverage(runDir, runId, journeys, opts);
  if (!report.totals.snapshots) return undefined;
  let evidenceId: string | undefined;
  if (existsSync(join(runDir, 'evidence-manifest.jsonl'))) {
    const vault = await EvidenceVault.resume(runDir);
    const ref = await vault.store('report', `coverage/ui-coverage-${Date.now()}.json`, JSON.stringify(report, null, 2), { description: 'UI coverage map' });
    evidenceId = ref.id;
  }
  await writeFile(join(runDir, UI_COVERAGE_FILE), JSON.stringify({ ...report, ...(evidenceId ? { evidenceId } : {}) }, null, 2));
  return { report, ...(evidenceId ? { evidenceId } : {}) };
}

export async function loadUiCoverage(runDir: string): Promise<(UiCoverageReport & { evidenceId?: string }) | undefined> {
  const p = join(runDir, UI_COVERAGE_FILE);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(await readFile(p, 'utf8')) as UiCoverageReport & { evidenceId?: string };
  } catch {
    return undefined;
  }
}

/** Element keys per snapshot node id of one snapshot (for the heat overlay). */
export function overlayMarks(html: string, page: UiPageCoverage, opts: UiCoverageOptions = {}): Array<{ nid: number; key: string; tested: boolean; interactions: number; assertions: number; label: string; role: string }> {
  const numbers = opts.normalizeNumbers !== false;
  const snap = interactiveElements(html, { testIdAttribute: opts.testIdAttribute });
  const byKey = new Map(page.elements.map((e) => [e.key, e]));
  const out: Array<{ nid: number; key: string; tested: boolean; interactions: number; assertions: number; label: string; role: string }> = [];
  for (const e of snap.elements) {
    const el = byKey.get(keyOf(e, numbers));
    if (!el) continue;
    out.push({ nid: e.nid, key: el.key, tested: el.tested, interactions: el.interactions, assertions: el.assertions, label: el.label, role: el.role });
  }
  return out;
}

/** CSS that paints the heat overlay into a rendered snapshot: tested elements solid green (darker = more use), untested dashed red. */
export function overlayCss(marks: ReturnType<typeof overlayMarks>, focusKey?: string): string {
  const tone = (n: number) => (n >= 5 ? '#166534' : n >= 2 ? '#15803d' : '#22c55e');
  const rules = marks.map((m) => {
    const sel = `[data-ez-nid="${m.nid}"]`;
    const focus = focusKey && m.key === focusKey ? `;box-shadow:0 0 0 6px rgba(37,99,235,.55)!important` : '';
    return m.tested
      ? `${sel}{outline:3px solid ${tone(m.interactions + m.assertions)}!important;outline-offset:1px!important;background-color:rgba(34,197,94,.14)!important${focus}}`
      : `${sel}{outline:3px dashed #dc2626!important;outline-offset:1px!important;background-color:rgba(220,38,38,.10)!important${focus}}`;
  });
  return `<style data-ez-coverage>${rules.join('\n')}</style>`;
}

/** Plain-text CLI report. */
export function uiCoverageText(r: UiCoverageReport, opts: { untested?: boolean; maxPerPage?: number } = {}): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const out: string[] = [];
  out.push(`UI coverage: ${r.totals.tested}/${r.totals.elements} interactive elements (${pct(r.totals.percent)}) on ${r.totals.pages} page(s), ${r.totals.snapshots} snapshot(s), runs ${r.runIds.join(', ') || 'none'}`);
  if (r.totals.links) out.push(`Links: ${r.totals.visitedLinks}/${r.totals.links} link targets visited`);
  for (const p of r.pages) {
    out.push('', `${p.route}  ${p.tested}/${p.total} (${pct(p.percent)})  journeys: ${p.journeys.join(', ') || '-'}`);
    const list = opts.untested === false ? p.elements : p.elements.filter((e) => !e.tested);
    for (const e of list.slice(0, opts.maxPerPage ?? 50)) {
      out.push(`  ${e.tested ? 'tested  ' : 'UNTESTED'}  ${e.role.padEnd(10)} ${e.label}${e.count > 1 ? ` (x${e.count})` : ''}${e.tested ? `  [${e.interactions} interaction(s), ${e.assertions} assertion(s); ${e.journeys.join(', ')}]` : ''}`);
    }
    if (list.length > (opts.maxPerPage ?? 50)) out.push(`  ... ${list.length - (opts.maxPerPage ?? 50)} more`);
  }
  if (r.unvisitedLinks.length) {
    out.push('', 'Links to pages no journey visited:');
    for (const l of r.unvisitedLinks) out.push(`  ${l.route}  ("${l.label}" on ${l.from.join(', ')})`);
  }
  for (const w of r.warnings) out.push(`warning: ${w}`);
  return out.join('\n');
}
