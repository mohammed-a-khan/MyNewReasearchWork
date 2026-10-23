/**
 * Cluster captured sessions into common paths, generate `.ez` journeys with
 * assertions ranked by frequency, and compute the coverage gap against the
 * journeys a project already has.
 */
import { slugify, type Journey } from '../core/index.js';
import { elementKey, eventSignature, pathOf, sessionSignature, type CapturedSession, type ElementDescriptor, type SemanticEvent } from './model.js';

export interface SessionCluster {
  /** Path signature shared by the sessions. */
  signature: string;
  /** Number of sessions on this path (its frequency). */
  count: number;
  /** Share of all clustered sessions. */
  frequency: number;
  /** Session ids in the cluster. */
  sessions: string[];
  /** The representative session (the longest, so assertions are richest). */
  representative: CapturedSession;
}

/** Group sessions by their interaction-path signature, most frequent first. */
export function clusterSessions(sessions: CapturedSession[]): SessionCluster[] {
  const groups = new Map<string, CapturedSession[]>();
  for (const s of sessions) {
    if (!s.events.some((e) => e.kind !== 'api')) continue; // nothing to drive
    const sig = sessionSignature(s);
    (groups.get(sig) ?? groups.set(sig, []).get(sig)!).push(s);
  }
  const total = [...groups.values()].reduce((n, g) => n + g.length, 0) || 1;
  return [...groups.entries()]
    .map(([signature, group]) => ({
      signature,
      count: group.length,
      frequency: group.length / total,
      sessions: group.map((s) => s.id),
      representative: [...group].sort((a, b) => b.events.length - a.events.length)[0],
    }))
    .sort((a, b) => b.count - a.count || b.representative.events.length - a.representative.events.length);
}

const target = (d: ElementDescriptor | undefined): string => {
  if (!d) return 'the element';
  if (d.name) return `the "${d.name}"${role(d)}`;
  if (d.label) return `the "${d.label}" field`;
  if (d.placeholder) return `the "${d.placeholder}" field`;
  if (d.testId) return `the "${d.testId}"${role(d)}`;
  if (d.id) return `the "#${d.id}" element`;
  return `the ${d.tag ?? 'element'}`;
};
const role = (d: ElementDescriptor): string => {
  const r = d.role === 'textbox' ? 'field' : d.role === 'link' ? 'link' : d.role === 'button' ? 'button' : d.role === 'combobox' ? 'dropdown' : d.role === 'checkbox' ? 'checkbox' : '';
  return r ? ` ${r}` : '';
};

/** One generated candidate journey. */
export interface GeneratedJourney {
  id: string;
  name: string;
  ez: string;
  signature: string;
  count: number;
  frequency: number;
  /** Steps that use a masked value (need a real value before the journey runs). */
  placeholders: string[];
}

export interface GenerateOptions {
  /** Only clusters seen at least this many times. Default 1. */
  minCount?: number;
  /** Cap on generated journeys. Default 50. */
  max?: number;
  namePrefix?: string;
}

/** Turn clusters into `.ez` journeys with assertions, ranked by frequency. */
export function generateJourneys(clusters: SessionCluster[], opts: GenerateOptions = {}): GeneratedJourney[] {
  const minCount = opts.minCount ?? 1;
  const out: GeneratedJourney[] = [];
  let n = 0;
  for (const c of clusters) {
    if (c.count < minCount || n >= (opts.max ?? 50)) break;
    const gen = journeyFromSession(c.representative, { ...(opts.namePrefix ? { namePrefix: opts.namePrefix } : {}), index: ++n });
    out.push({ ...gen, signature: c.signature, count: c.count, frequency: c.frequency });
  }
  return out;
}

function journeyFromSession(session: CapturedSession, o: { namePrefix?: string; index: number }): Omit<GeneratedJourney, 'signature' | 'count' | 'frequency'> {
  const lines: string[] = [];
  const placeholders: string[] = [];
  const nav = session.events.find((e) => e.kind === 'navigate') as Extract<SemanticEvent, { kind: 'navigate' }> | undefined;
  const titleHint = nav?.title?.replace(/\s+/g, ' ').trim();
  const name = `${o.namePrefix ?? 'Captured journey'} ${o.index}${titleHint ? ` - ${titleHint.slice(0, 40)}` : ''}`;
  const id = slugify(`captured-${o.index}-${titleHint ?? sessionSignature(session).slice(0, 20)}`);
  lines.push(`Journey: ${name}`);
  lines.push(`Tags: captured`);
  let lastPath = '';
  let placeholderN = 0;
  for (const e of session.events) {
    switch (e.kind) {
      case 'navigate': {
        const p = pathOf(e.url);
        if (lines.filter((l) => l.startsWith('Open ')).length === 0) lines.push(`Open "${safeUrl(e.url, session.baseUrl)}"`);
        else if (p !== lastPath) lines.push(`  Expect the URL to contain "${p.replace(/\{id\}/g, '')}"`.replace(/\s+"\/?"$/, ' "/"'));
        if (e.title && e.title.trim()) lines.push(`  Expect the page to contain "${firstWords(e.title)}"`);
        lastPath = p;
        break;
      }
      case 'click':
        lines.push(`Click ${target(e.target)}`);
        break;
      case 'input': {
        const ph = `value${++placeholderN}`;
        placeholders.push(ph);
        lines.push(`Type "\${${ph}}" into ${target(e.target)}`);
        break;
      }
      case 'select':
        lines.push(`Select "${e.value ?? '…'}" from ${target(e.target)}`);
        break;
      case 'check':
        lines.push(`Check ${target(e.target)}`);
        break;
      case 'uncheck':
        lines.push(`Uncheck ${target(e.target)}`);
        break;
      case 'submit':
        lines.push(`Click ${target(e.target)}`);
        break;
      case 'assert':
        lines.push(`Expect the page to contain "${firstWords(e.text)}"`);
        break;
      case 'api':
        break; // API calls inform coverage, not steps
    }
  }
  // A final assertion so the journey verifies something.
  if (!lines.some((l) => l.trimStart().startsWith('Expect'))) {
    const last = session.events.filter((e) => e.kind === 'navigate').at(-1) as Extract<SemanticEvent, { kind: 'navigate' }> | undefined;
    if (last) lines.push(`  Expect the URL to contain "${pathOf(last.url).replace(/\{id\}/g, '')}"`);
  }
  let ez = lines.join('\n') + '\n';
  if (placeholders.length) {
    ez = ez.replace('Tags: captured', `Tags: captured\nVariables: ${placeholders.map((p) => `${p}=REPLACE_ME`).join(', ')}`);
  }
  return { id, name, ez, placeholders };
}

function safeUrl(url: string, base?: string): string {
  try {
    const u = new URL(url);
    const b = base ? new URL(base) : undefined;
    return b && u.origin === b.origin ? u.pathname + u.search : url;
  } catch {
    return url;
  }
}
const firstWords = (s: string, n = 6) => s.replace(/\s+/g, ' ').trim().split(' ').slice(0, n).join(' ').replace(/"/g, "'");

// ------------------------------------------------------------------ coverage gap

export interface CoverageGap {
  /** Candidate clusters not covered by any existing journey. */
  uncovered: Array<{ signature: string; count: number; frequency: number; suggestion: string }>;
  /** Candidate clusters an existing journey already covers. */
  covered: Array<{ signature: string; count: number; journeyId: string }>;
  /** Share of captured sessions (by count) already covered. */
  coverageRatio: number;
}

/** A journey's path signature from its steps (navigations + click/type/select targets), to compare with a cluster. */
export function journeySignature(journey: Journey): string {
  const parts: string[] = [];
  for (const s of journey.steps) {
    if (s.action === 'click' || s.action === 'fill' || s.action === 'select' || s.action === 'check' || s.action === 'uncheck') {
      const d = descriptorFromTarget(s.target?.description ?? '');
      parts.push(`${s.action === 'fill' ? 'input' : s.action}:${elementKey(d)}`);
    } else if (s.action === 'navigate' || (s.action === 'browser' && s.args?.op === 'goto')) {
      const url = s.value ?? String(s.args?.url ?? '');
      if (url) parts.push(`navigate:${pathOf(url)}`);
    }
  }
  return parts.join(' > ');
}

function descriptorFromTarget(desc: string): ElementDescriptor {
  const m = /"([^"]+)"\s*(button|link|field|dropdown|checkbox)?/.exec(desc);
  const name = m?.[1] ?? desc.replace(/^the\s+/i, '');
  const kind = m?.[2];
  const roleMap: Record<string, string> = { button: 'button', link: 'link', field: 'textbox', dropdown: 'combobox', checkbox: 'checkbox' };
  return { name, ...(kind ? { role: roleMap[kind] } : {}) };
}

/** Longest-common-subsequence ratio of two event-signature paths (0..1). */
export function pathOverlap(a: string, b: string): number {
  const x = a.split(' > ').filter(Boolean);
  const y = b.split(' > ').filter(Boolean);
  if (!x.length || !y.length) return 0;
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) dp[i][j] = x[i - 1] === y[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[x.length][y.length] / Math.max(x.length, y.length);
}

/** Which captured clusters existing journeys already cover (>= `threshold` path overlap). */
export function coverageGap(clusters: SessionCluster[], journeys: Journey[], threshold = 0.8): CoverageGap {
  const sigs = journeys.map((j) => ({ id: j.id, sig: journeySignature(j) })).filter((j) => j.sig);
  const uncovered: CoverageGap['uncovered'] = [];
  const covered: CoverageGap['covered'] = [];
  let coveredCount = 0;
  let totalCount = 0;
  for (const c of clusters) {
    totalCount += c.count;
    const hit = sigs.map((j) => ({ id: j.id, o: pathOverlap(c.signature, j.sig) })).sort((a, b) => b.o - a.o)[0];
    if (hit && hit.o >= threshold) {
      covered.push({ signature: c.signature, count: c.count, journeyId: hit.id });
      coveredCount += c.count;
    } else {
      uncovered.push({ signature: c.signature, count: c.count, frequency: c.frequency, suggestion: `${c.count} session(s) follow a path no journey covers${hit && hit.o > 0 ? ` (closest: ${hit.id}, ${(hit.o * 100).toFixed(0)}% overlap)` : ''}` });
    }
  }
  return { uncovered, covered, coverageRatio: totalCount ? coveredCount / totalCount : 1 };
}
