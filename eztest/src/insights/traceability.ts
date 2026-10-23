/**
 * Requirements traceability: requirements x journeys x latest status, from the
 * journeys' `requirements` headers, the latest result of each journey, the
 * quarantine and an optional list of known requirements (so requirements no
 * journey covers show up as gaps).
 */
import type { JourneyStatus } from '../core/index.js';

export interface TraceJourney {
  id: string;
  name: string;
  path?: string;
  requirements: string[];
  tags?: string[];
  risk?: number;
  /** automated, manual or hybrid (manual results count like automated ones). */
  kind?: 'automated' | 'manual' | 'hybrid';
}

export interface TraceLatest {
  status: JourneyStatus;
  runId: string;
  startedAt?: string;
}

export interface RequirementInfo {
  id: string;
  title?: string;
  /** Where the requirement came from: a journey header, a CSV list, an ADO query. */
  source?: string;
  state?: string;
  area?: string;
}

/** Overall coverage of one requirement. */
export type CoverageState =
  | 'covered-passing'
  | 'covered-healed'
  | 'covered-failing'
  | 'covered-quarantined'
  | 'not-run'
  | 'uncovered';

export interface TraceCell {
  journeyId: string;
  status: JourneyStatus | 'not-run';
  quarantined: boolean;
  runId?: string;
}

export interface TraceRow {
  requirement: RequirementInfo;
  journeys: TraceCell[];
  coverage: CoverageState;
  /** Gap explanation, when the requirement is not covered by a passing, non-quarantined journey. */
  gap?: string;
}

export interface TraceabilityMatrix {
  rows: TraceRow[];
  journeys: Array<TraceJourney & { latest?: TraceLatest; quarantined: boolean }>;
  /** Requirements referenced by journeys but missing from the supplied list (when a list was given). */
  unknownRequirements: string[];
  /** Journeys that trace to no requirement. */
  untracedJourneys: string[];
  totals: Record<CoverageState, number> & { requirements: number; gaps: number; coveragePct: number };
}

const PASS: ReadonlySet<string> = new Set(['passed', 'passed-healed']);

function rank(c: TraceCell): number {
  if (c.quarantined) return 1;
  if (c.status === 'passed') return 5;
  if (c.status === 'passed-healed') return 4;
  if (c.status === 'not-run' || c.status === 'skipped') return 2;
  return 3; // failed / error
}

export function computeTraceability(input: {
  journeys: TraceJourney[];
  latest: Record<string, TraceLatest | undefined>;
  quarantined?: Iterable<string>;
  /** Known requirements (CSV, ADO). When given, uncovered ones become rows too. */
  requirements?: RequirementInfo[];
}): TraceabilityMatrix {
  const q = new Set(input.quarantined ?? []);
  const known = new Map<string, RequirementInfo>();
  for (const r of input.requirements ?? []) if (r.id.trim()) known.set(r.id.trim(), { ...r, id: r.id.trim() });
  const byReq = new Map<string, TraceJourney[]>();
  for (const j of input.journeys) {
    for (const r of new Set(j.requirements.map((x) => x.trim()).filter(Boolean))) byReq.set(r, [...(byReq.get(r) ?? []), j]);
  }
  const unknownRequirements = input.requirements ? [...byReq.keys()].filter((r) => !known.has(r)).sort() : [];
  const ids = new Set([...known.keys(), ...byReq.keys()]);
  const rows: TraceRow[] = [];
  for (const id of [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const req = known.get(id) ?? { id, source: 'journey header' };
    const cells: TraceCell[] = (byReq.get(id) ?? []).map((j) => {
      const l = input.latest[j.id];
      return { journeyId: j.id, status: l?.status ?? 'not-run', quarantined: q.has(j.id), runId: l?.runId };
    });
    cells.sort((a, b) => rank(b) - rank(a) || a.journeyId.localeCompare(b.journeyId));
    let coverage: CoverageState;
    let gap: string | undefined;
    const live = cells.filter((c) => !c.quarantined);
    if (cells.length === 0) {
      coverage = 'uncovered';
      gap = 'no journey traces to this requirement';
    } else if (live.some((c) => c.status === 'passed')) coverage = 'covered-passing';
    else if (live.some((c) => c.status === 'passed-healed')) {
      coverage = 'covered-healed';
      gap = 'only passes with healing; review the heals so the journey passes on its own locators';
    } else if (live.some((c) => c.status === 'failed' || c.status === 'error')) {
      coverage = 'covered-failing';
      gap = `every covering journey is failing (${live.filter((c) => !PASS.has(c.status)).map((c) => c.journeyId).join(', ')})`;
    } else if (live.length === 0) {
      coverage = 'covered-quarantined';
      gap = `only quarantined journeys cover it (${cells.map((c) => c.journeyId).join(', ')})`;
    } else {
      coverage = 'not-run';
      gap = 'covering journeys have not run yet';
    }
    rows.push({ requirement: req, journeys: cells, coverage, ...(gap ? { gap } : {}) });
  }
  const totals = { requirements: rows.length, gaps: 0, coveragePct: 0, 'covered-passing': 0, 'covered-healed': 0, 'covered-failing': 0, 'covered-quarantined': 0, 'not-run': 0, uncovered: 0 } as TraceabilityMatrix['totals'];
  for (const r of rows) {
    totals[r.coverage]++;
    if (r.coverage !== 'covered-passing' && r.coverage !== 'covered-healed') totals.gaps++;
  }
  totals.coveragePct = rows.length ? (totals['covered-passing'] + totals['covered-healed']) / rows.length : 0;
  return {
    rows,
    journeys: input.journeys.map((j) => ({ ...j, latest: input.latest[j.id], quarantined: q.has(j.id) })),
    unknownRequirements,
    untracedJourneys: input.journeys.filter((j) => j.requirements.length === 0).map((j) => j.id).sort(),
    totals,
  };
}

/** Parse one CSV line (RFC 4180 quoting). */
function csvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Requirements from CSV text. A header row naming an id column (id, requirement, key,
 * work item id) and optionally title/name/summary, state/status, area is used when present;
 * otherwise the first column is the id and the second the title.
 */
export function parseRequirementsCsv(text: string, source = 'csv'): RequirementInfo[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) return [];
  const head = csvLine(lines[0]).map((h) => h.toLowerCase());
  const find = (...names: string[]) => head.findIndex((h) => names.includes(h));
  let idCol = find('id', 'requirement', 'requirement id', 'key', 'work item id', 'req', 'req id');
  let titleCol = find('title', 'name', 'summary', 'description');
  const stateCol = find('state', 'status');
  const areaCol = find('area', 'area path', 'component');
  let body = lines.slice(1);
  if (idCol < 0) {
    idCol = 0;
    titleCol = 1;
    body = lines;
  }
  const out: RequirementInfo[] = [];
  const seen = new Set<string>();
  for (const l of body) {
    const cols = csvLine(l);
    const id = cols[idCol]?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      ...(titleCol >= 0 && cols[titleCol] ? { title: cols[titleCol] } : {}),
      ...(stateCol >= 0 && cols[stateCol] ? { state: cols[stateCol] } : {}),
      ...(areaCol >= 0 && cols[areaCol] ? { area: cols[areaCol] } : {}),
      source,
    });
  }
  return out;
}

const csvCell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** One row per requirement x journey (uncovered requirements get one row with no journey). */
export function traceabilityToCsv(m: TraceabilityMatrix): string {
  const rows = [['Requirement', 'Title', 'Coverage', 'Journey', 'Journey name', 'Latest status', 'Quarantined', 'Run', 'Gap']];
  const names = new Map(m.journeys.map((j) => [j.id, j.name]));
  for (const r of m.rows) {
    const base = [r.requirement.id, r.requirement.title ?? '', r.coverage];
    if (!r.journeys.length) rows.push([...base, '', '', '', '', '', r.gap ?? '']);
    for (const c of r.journeys) rows.push([...base, c.journeyId, names.get(c.journeyId) ?? '', c.status, c.quarantined ? 'yes' : 'no', c.runId ?? '', r.gap ?? '']);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
