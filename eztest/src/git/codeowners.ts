/**
 * CODEOWNERS for journey ownership (triage routing, bug assignment, heal PR
 * reviewers). Reads the GitHub, GitLab and Azure Repos conventions:
 *
 *  - GitHub: `CODEOWNERS`, `.github/CODEOWNERS`, `docs/CODEOWNERS`; the last
 *    matching line wins.
 *  - GitLab: also `.gitlab/CODEOWNERS`; `[Section]`, `^[Optional section]`,
 *    `[Section][2]` and default owners on the section line. The last match
 *    within each section wins and the owners of every section are combined.
 *  - Azure Repos has no native CODEOWNERS; the same file is read from
 *    `.azuredevops/CODEOWNERS` too, and owners may be e-mail addresses or
 *    ADO group names (`[Project]\Team`, quoted when they contain spaces).
 *
 * Patterns follow gitignore rules (anchored when they contain a slash,
 * trailing slash = directory, `*`, `**`, `?`).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type OwnerKind = 'user' | 'team' | 'email' | 'group';

export interface Owner {
  raw: string;
  kind: OwnerKind;
  /** User or team name without "@", the e-mail, or the group name. */
  name: string;
}

export interface CodeownersRule {
  pattern: string;
  owners: Owner[];
  line: number;
  section?: string;
  optional?: boolean;
  re: RegExp;
}

export interface Codeowners {
  file?: string;
  rules: CodeownersRule[];
  errors: Array<{ line: number; message: string }>;
}

export const CODEOWNERS_LOCATIONS = ['.github/CODEOWNERS', '.gitlab/CODEOWNERS', '.azuredevops/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

export function parseOwner(raw: string): Owner | undefined {
  const t = raw.trim().replace(/^"(.*)"$/, '$1');
  if (!t) return undefined;
  if (/^@[\w.-]+\/[\w./-]+$/.test(t)) return { raw: t, kind: 'team', name: t.slice(1) };
  if (/^@[\w.-]+$/.test(t)) return { raw: t, kind: 'user', name: t.slice(1) };
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) return { raw: t, kind: 'email', name: t };
  if (/^\[[^\]]+\]\\.+$/.test(t)) return { raw: t, kind: 'group', name: t };
  return undefined;
}

/** Split an owners list: whitespace separated, double quotes keep spaces (ADO group names). */
function ownerTokens(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2]);
  return out;
}

function globSource(g: string): string {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += /[\\^$.+()[\]{}|/]/.test(c) ? `\\${c}` : c;
  }
  return re;
}

function patternRegExp(pattern: string): RegExp {
  let p = pattern.replace(/\\#/g, '#').replace(/\\ /g, ' ');
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || p.includes('/');
  p = p.replace(/^\//, '');
  if (p === '*' || p === '**' || p === '') return /^.*$/;
  const self = globSource(anchored ? p : `**/${p}`);
  // A file pattern also matches when it names a directory: everything below it is owned too.
  return new RegExp(dirOnly ? `^${self}/.*$` : `^${self}(?:/.*)?$`);
}

export function parseCodeowners(text: string, file?: string): Codeowners {
  const rules: CodeownersRule[] = [];
  const errors: Codeowners['errors'] = [];
  let section: string | undefined;
  let optional = false;
  let sectionDefaults: Owner[] = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    const sec = /^(\^)?\[([^\]]+)\](?:\[\d+\])?\s*(.*)$/.exec(line);
    if (sec && !line.includes('\\')) {
      optional = !!sec[1];
      section = sec[2].trim();
      sectionDefaults = ownerTokens(sec[3]).map(parseOwner).filter((o): o is Owner => !!o);
      return;
    }
    const [pattern, ...rest] = ownerTokens(line.replace(/\\ /g, '\u0000')).map((t) => t.replace(/\u0000/g, '\\ '));
    const owners: Owner[] = [];
    for (const r of rest) {
      const o = parseOwner(r);
      if (o) owners.push(o);
      else errors.push({ line: i + 1, message: `unrecognised owner ${JSON.stringify(r)}` });
    }
    try {
      rules.push({ pattern, owners: owners.length ? owners : sectionDefaults, line: i + 1, ...(section ? { section } : {}), ...(optional ? { optional } : {}), re: patternRegExp(pattern) });
    } catch (e) {
      errors.push({ line: i + 1, message: (e as Error).message });
    }
  });
  return { ...(file ? { file } : {}), rules, errors };
}

/** Owners of a repository-relative path. Empty when nothing matches (or the last match has no owners). */
export function ownersOf(co: Codeowners, path: string): Owner[] {
  const p = path.split('\\').join('/').replace(/^\.?\//, '');
  const bySection = new Map<string, CodeownersRule>();
  for (const r of co.rules) if (r.re.test(p)) bySection.set(r.section ?? '', r);
  const out: Owner[] = [];
  for (const r of bySection.values()) for (const o of r.owners) if (!out.some((x) => x.raw === o.raw)) out.push(o);
  return out;
}

/** Find and parse the repository's CODEOWNERS (first location that exists). */
export async function loadCodeowners(repoRoot: string): Promise<Codeowners> {
  for (const loc of CODEOWNERS_LOCATIONS) {
    const p = join(repoRoot, loc);
    if (existsSync(p)) return parseCodeowners(await readFile(p, 'utf8'), loc);
  }
  return { rules: [], errors: [] };
}

/**
 * A work item "Assigned To" value for owners: the first e-mail owner, or a user
 * mapped through `aliases` (`@alice` -> `alice@contoso.com`).
 */
export function assigneeFor(owners: Owner[], aliases: Record<string, string> = {}): string | undefined {
  for (const o of owners) {
    if (aliases[o.raw]) return aliases[o.raw];
    if (o.kind === 'email') return o.name;
  }
  return undefined;
}
