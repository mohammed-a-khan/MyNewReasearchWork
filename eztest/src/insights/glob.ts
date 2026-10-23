/**
 * Minimal glob matcher (no dependencies, no regex input from users):
 * `**` any path segments, `*` within a segment, `?` one char, `{a,b}` alternatives.
 */
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { EzTestError } from '../core/index.js';

const cache = new Map<string, RegExp>();

function escapeRe(c: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(c) ? `\\${c}` : c;
}

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  if (glob.length === 0) throw new EzTestError('Empty glob pattern', 'INVALID_GLOB');
  let re = '';
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" matches zero or more directories; trailing "**" matches everything
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      braceDepth++;
      re += '(?:';
    } else if (c === '}' && braceDepth > 0) {
      braceDepth--;
      re += ')';
    } else if (c === ',' && braceDepth > 0) re += '|';
    else re += escapeRe(c);
  }
  if (braceDepth !== 0) throw new EzTestError(`Unbalanced braces in glob ${glob}`, 'INVALID_GLOB');
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

export function globMatch(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path.split('\\').join('/').replace(/^\.\//, ''));
}

/**
 * Match a URL against a pattern. Patterns without "/" match the host (e.g.
 * "*.example.com"); otherwise host + pathname (e.g. "api.example.com/orders/**").
 */
export function urlMatches(pattern: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!pattern.includes('/')) return globMatch(pattern, u.host) || globMatch(pattern, u.hostname);
  return globMatch(pattern, `${u.host}${u.pathname}`) || globMatch(pattern, `${u.hostname}${u.pathname}`);
}

const GLOB_SKIP = new Set(['node_modules', '.git', 'dist', '.eztest', 'coverage']);

/** Expand file globs (or plain paths/directories) to a sorted, de-duplicated list of files, relative to cwd. */
export async function expandGlobs(patterns: string[], cwd = process.cwd()): Promise<string[]> {
  const out = new Set<string>();
  const roots = new Set<string>();
  const globs = patterns.filter((p) => /[*?{]/.test(p));
  for (const p of patterns) {
    if (/[*?{]/.test(p)) continue;
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    try {
      const st = await stat(abs);
      if (st.isDirectory()) roots.add(abs);
      else out.add(abs);
    } catch {
      /* missing plain path is ignored */
    }
  }
  if (globs.length) roots.add(cwd);
  const walk = async (dir: string): Promise<void> => {
    for (const ent of (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (ent.name.startsWith('.') && ent.name !== '.' || GLOB_SKIP.has(ent.name)) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else {
        const rel = relative(cwd, full).split('\\').join('/');
        if (globs.some((g) => globMatch(g, rel))) out.add(full);
      }
    }
  };
  for (const r of roots) await walk(r);
  return [...out].sort();
}
