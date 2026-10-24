/**
 * Tidy a feature file: standard indentation (Feature 0, Rule / Background /
 * Scenario 2, steps 4, arguments 6; one more level inside a Rule) and data
 * tables with aligned columns. Comments, descriptions and doc string
 * content are kept as written (doc strings move with their step).
 */
import { parseGherkin } from './gherkin/parser.js';
import { dialectFor } from './gherkin/languages.js';

const escCell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '\\n');

/** Throws GherkinParseError when the text does not parse (nothing is changed then). */
export function formatFeature(text: string, o: { language?: string } = {}): string {
  const doc = parseGherkin(text, 'format.feature', o);
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const dialect = dialectFor(doc.feature?.language ?? o.language ?? 'en') ?? dialectFor('en')!;
  const isBlock = (t: string) => dialect.blocks.find((b) => t.startsWith(b.keyword) && t[b.keyword.length] === ':');
  const isStep = (t: string) => dialect.steps.some((s) => t.startsWith(s.keyword) && (t.length === s.keyword.length || /\s/.test(t[s.keyword.length]) || s.keyword.endsWith("'")));
  const out: string[] = [];
  let inRule = false;
  let base = 0; // indentation of the current block's children
  let table: string[][] = [];
  let tableIndent = 0;
  const flushTable = () => {
    if (!table.length) return;
    const widths = table.reduce<number[]>((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), []);
    for (const r of table) out.push(`${' '.repeat(tableIndent)}| ${r.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')} |`);
    table = [];
  };
  let pendingTags: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t.startsWith('|')) flushTable();
    if (!t) {
      out.push('');
      continue;
    }
    if (t.startsWith('"""') || t.startsWith('```')) {
      const delim = t.slice(0, 3);
      const oldIndent = raw.length - raw.trimStart().length;
      const indent = base + 2;
      out.push(`${' '.repeat(indent)}${t}`);
      for (i++; i < lines.length && lines[i].trim() !== delim; i++) {
        const l = lines[i];
        const lead = /^[ \t]*/.exec(l)?.[0].length ?? 0;
        out.push(l.trim() ? `${' '.repeat(indent)}${l.slice(Math.min(lead, oldIndent))}` : '');
      }
      out.push(`${' '.repeat(indent)}${delim}`);
      continue;
    }
    if (t.startsWith('|')) {
      if (!table.length) tableIndent = base + 2;
      table.push(splitCells(t).map(escCell));
      continue;
    }
    if (t.startsWith('#')) {
      out.push(/^#\s*language\s*:/.test(t) ? t : `${' '.repeat(Math.max(0, base))}${t}`);
      continue;
    }
    if (t.startsWith('@')) {
      pendingTags.push(t);
      continue;
    }
    const b = isBlock(t);
    if (b) {
      let indent: number;
      if (b.kind === 'feature') {
        indent = 0;
        inRule = false;
      } else if (b.kind === 'rule') {
        indent = 2;
        inRule = true;
      } else if (b.kind === 'examples') indent = inRule ? 6 : 4;
      else indent = inRule ? 4 : 2;
      for (const tg of pendingTags) out.push(`${' '.repeat(indent)}${tg}`);
      pendingTags = [];
      out.push(`${' '.repeat(indent)}${t}`);
      base = indent + 2;
      continue;
    }
    if (isStep(t)) {
      const indent = inRule ? 6 : 4;
      out.push(`${' '.repeat(indent)}${t}`);
      base = indent;
      continue;
    }
    // Description text: one level under its block.
    out.push(`${' '.repeat(base)}${t}`);
  }
  flushTable();
  while (out.length && !out[out.length - 1]) out.pop();
  return `${out.join('\n')}\n`;
}

function splitCells(t: string): string[] {
  const cells: string[] = [];
  let cur = '';
  for (let i = 1; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\\' && i + 1 < t.length) {
      const nx = t[i + 1];
      cur += nx === 'n' ? '\n' : nx === '|' ? '|' : nx === '\\' ? '\\' : ch + nx;
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  return cells;
}
