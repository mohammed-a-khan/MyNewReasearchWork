/**
 * Element uses in code (code journeys, step definitions, screen modules, helpers), read statically as text, for
 * `eztest elements unused|list`: a screen model's entry (`ui.table(TheInternet.firstTable)`, the screen made by
 * `screen('TheInternet', {...})`, imported under any name) and a reference in a string (`'the @Shop.cart table'`).
 * Screen models share the repository's ids (docs/elements.md), so both are uses of the repository element.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ElementUsage } from './bind.js';
import { screenId, type ElementRepository } from './repository.js';

export interface CodeSource {
  /** Project-relative path. */
  file: string;
  text: string;
}

const CODE_FILE = /\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx)$/i;
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', 'coverage', 'eztest-results']);
const SCREEN_DEF = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*screen\s*\(\s*(['"`])([^'"`]+)\2/g;
const IMPORT_AS = /\bimport\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;
/** `@Screen.element` inside a string or template literal (after a quote, a space or an opening bracket). */
const STRING_REF = /(?<=['"`\s([{,])@([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+)(?=[\s'"`,)\]}]|$)/g;

/** Code files under `dirs` (project-relative or absolute), skipping dependencies, build output and dot folders. */
export async function codeFilesUnder(root: string, dirs: string[]): Promise<CodeSource[]> {
  const seen = new Set<string>();
  const out: CodeSource[] = [];
  const walk = async (d: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(d)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') || SKIP_DIR.has(name)) continue;
      const p = join(d, name);
      const s = await stat(p).catch(() => undefined);
      if (!s) continue;
      if (s.isDirectory()) await walk(p);
      else if (CODE_FILE.test(name) && !/\.d\.[cm]?ts$/i.test(name) && !seen.has(p)) {
        seen.add(p);
        out.push({ file: relative(root, p).split('\\').join('/'), text: await readFile(p, 'utf8') });
      }
    }
  };
  for (const d of dirs) {
    const abs = join(root, d);
    if (!existsSync(abs)) continue;
    if ((await stat(abs)).isDirectory()) await walk(abs);
    else if (CODE_FILE.test(abs) && !seen.has(abs)) {
      seen.add(abs);
      out.push({ file: relative(root, abs).split('\\').join('/'), text: await readFile(abs, 'utf8') });
    }
  }
  return out;
}

/** The folder a glob starts from: `apps/web/steps/**\/*.steps.ts` -> `apps/web/steps`. */
export function globBase(pattern: string): string {
  const parts = pattern.split(/[\\/]/);
  const i = parts.findIndex((p) => /[*?[\]{}]/.test(p));
  return (i < 0 ? parts.slice(0, -1) : parts.slice(0, i)).join('/') || '.';
}

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

/**
 * Every use of a repository element in `sources`, keyed by element id. A screen entry counts when the repository
 * has that id (a screen's functions and other members are not elements); a string reference counts under its id
 * either way, so a reference to an unknown element is reported as unknown, as in journeys.
 */
export function codeElementUsages(sources: CodeSource[], repo: ElementRepository): Map<string, ElementUsage[]> {
  // Screen variables of every file: the variable name (and the names it is imported under) -> the screen's id.
  const screens = new Map<string, string>();
  for (const s of sources) for (const m of s.text.matchAll(SCREEN_DEF)) screens.set(m[1], screenId(m[3]));
  const out = new Map<string, ElementUsage[]>();
  const add = (id: string, s: CodeSource, index: number) => {
    const line = lineAt(s.text, index);
    const intent = (s.text.split('\n')[line - 1] ?? '').trim().slice(0, 160);
    const u: ElementUsage = { journeyId: s.file, journeyName: s.file, stepId: `line ${line}`, intent, via: 'code', role: 'target' };
    out.set(id, [...(out.get(id) ?? []), u]);
  };
  for (const s of sources) {
    const names = new Map(screens);
    for (const m of s.text.matchAll(IMPORT_AS)) {
      for (const part of m[1].split(',')) {
        const a = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(part);
        if (a && screens.has(a[1])) names.set(a[2], screens.get(a[1])!);
      }
    }
    for (const [variable, screen] of names) {
      const re = new RegExp(String.raw`(?<![\w$.])${variable.replace(/\$/g, '\\$')}\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)`, 'g');
      for (const m of s.text.matchAll(re)) {
        const id = `${screen}.${m[1]}`;
        if (repo.get(id)) add(id, s, m.index ?? 0);
      }
    }
    for (const m of s.text.matchAll(STRING_REF)) add(m[1], s, m.index ?? 0);
  }
  return out;
}

/**
 * The folders of a project's code: its journeys folder (code journeys, screens, helpers next to them), the screen
 * folders of `elements.screens` and the folders of its step definitions (`bdd.steps`).
 */
export function projectCodeDirs(cfg: { journeysDir: string; elements?: { screens?: string[] }; bdd?: { steps?: string[] } }): string[] {
  return [...new Set([cfg.journeysDir, ...(cfg.elements?.screens ?? []), ...(cfg.bdd?.steps ?? []).map(globBase)])];
}

/** Element uses in the code of a project (see projectCodeDirs). */
export async function projectCodeUsages(root: string, cfg: Parameters<typeof projectCodeDirs>[0], repo: ElementRepository): Promise<Map<string, ElementUsage[]>> {
  return codeElementUsages(await codeFilesUnder(root, projectCodeDirs(cfg)), repo);
}

/** Journey uses and code uses together. */
export function mergeUsages(a: Map<string, ElementUsage[]>, b: Map<string, ElementUsage[]>): Map<string, ElementUsage[]> {
  const out = new Map(a);
  for (const [id, list] of b) out.set(id, [...(out.get(id) ?? []), ...list]);
  return out;
}
