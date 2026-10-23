/**
 * Merge conflicts in journey files: parse the conflict markers git leaves
 * (merge or diff3 style) into hunks, resolve each hunk (ours, theirs, both,
 * base or edited text) and check that the result is still a valid journey
 * before it is written and staged.
 */
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { parseEzScript } from '../intent/index.js';

export interface ConflictHunk {
  index: number;
  /** 1-based line of the `<<<<<<<` marker in the working file. */
  startLine: number;
  endLine: number;
  oursLabel: string;
  theirsLabel: string;
  ours: string[];
  base?: string[];
  theirs: string[];
}

export type ConflictPart = { type: 'text'; lines: string[] } | { type: 'conflict'; hunk: ConflictHunk };

export interface ParsedConflict {
  parts: ConflictPart[];
  hunks: ConflictHunk[];
  /** sha256 of the working text the hunks were parsed from (to detect concurrent edits). */
  hash: string;
}

export type HunkChoice = 'ours' | 'theirs' | 'both' | 'theirs-then-ours' | 'base' | { text: string };

export function parseConflicts(text: string): ParsedConflict {
  const lines = text.split('\n');
  const parts: ConflictPart[] = [];
  const hunks: ConflictHunk[] = [];
  let buf: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('<<<<<<<')) {
      if (buf.length) parts.push({ type: 'text', lines: buf });
      buf = [];
      const start = i + 1;
      const oursLabel = l.slice(7).trim();
      const ours: string[] = [];
      let base: string[] | undefined;
      const theirs: string[] = [];
      let section: 'ours' | 'base' | 'theirs' = 'ours';
      i++;
      let theirsLabel = '';
      let closed = false;
      for (; i < lines.length; i++) {
        const x = lines[i];
        if (x.startsWith('|||||||') && section === 'ours') {
          section = 'base';
          base = [];
          continue;
        }
        if (x.startsWith('=======') && section !== 'theirs') {
          section = 'theirs';
          continue;
        }
        if (x.startsWith('>>>>>>>') && section === 'theirs') {
          theirsLabel = x.slice(7).trim();
          closed = true;
          break;
        }
        (section === 'ours' ? ours : section === 'base' ? base! : theirs).push(x);
      }
      if (!closed) throw new Error(`Unterminated conflict starting at line ${start}`);
      const hunk: ConflictHunk = { index: hunks.length, startLine: start, endLine: i + 1, oursLabel, theirsLabel, ours, ...(base ? { base } : {}), theirs };
      hunks.push(hunk);
      parts.push({ type: 'conflict', hunk });
      i++;
      continue;
    }
    buf.push(l);
    i++;
  }
  if (buf.length) parts.push({ type: 'text', lines: buf });
  return { parts, hunks, hash: createHash('sha256').update(text).digest('hex') };
}

export function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<< |^>>>>>>> /m.test(text);
}

/** Apply one choice per hunk (missing choices keep the markers). */
export function resolveConflicts(parsed: ParsedConflict, choices: Record<number, HunkChoice>): string {
  const out: string[] = [];
  for (const p of parsed.parts) {
    if (p.type === 'text') {
      out.push(...p.lines);
      continue;
    }
    const h = p.hunk;
    const c = choices[h.index];
    if (c === undefined) {
      out.push(`<<<<<<< ${h.oursLabel}`.trimEnd(), ...h.ours, ...(h.base ? ['|||||||', ...h.base] : []), '=======', ...h.theirs, `>>>>>>> ${h.theirsLabel}`.trimEnd());
    } else if (c === 'ours') out.push(...h.ours);
    else if (c === 'theirs') out.push(...h.theirs);
    else if (c === 'both') out.push(...h.ours, ...h.theirs.filter((t) => !h.ours.includes(t) || !t.trim()));
    else if (c === 'theirs-then-ours') out.push(...h.theirs, ...h.ours.filter((t) => !h.theirs.includes(t) || !t.trim()));
    else if (c === 'base') out.push(...(h.base ?? []));
    else out.push(...c.text.split('\n'));
  }
  return out.join('\n');
}

export interface JourneyCheck {
  ok: boolean;
  error?: string;
  steps?: number;
}

/** Whether resolved text is a valid journey for its format (.ez, .yaml/.yml, .json). Other files only need no markers. */
export function checkResolvedJourney(path: string, text: string): JourneyCheck {
  if (hasConflictMarkers(text)) return { ok: false, error: 'conflict markers remain' };
  try {
    if (/\.ez$/i.test(path)) {
      const j = parseEzScript(text, { source: path });
      return { ok: true, steps: j.steps.length };
    }
    if (/\.ya?ml$/i.test(path)) {
      parseYaml(text);
      return { ok: true };
    }
    if (/\.json$/i.test(path)) {
      JSON.parse(text);
      return { ok: true };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message.split('\n')[0] };
  }
}
