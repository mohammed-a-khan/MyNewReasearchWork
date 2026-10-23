/**
 * Minimal .env parser: KEY=value, `export KEY=value`, # comments, single
 * quotes (literal), double quotes (with \n \t \" \\ escapes, may span lines).
 * No variable expansion here; ${VAR} is handled by config interpolation.
 */
import { readFileSync, existsSync } from 'node:fs';
import { EzTestError } from '../core/index.js';

export function parseDotenv(text: string, source = '.env'): Record<string, string> {
  const out: Record<string, string> = {};
  const src = text.replace(/\r\n?/g, '\n');
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    // skip whitespace and blank lines
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
    if (src[i] === '\n') {
      i++;
      line++;
      continue;
    }
    if (i >= n) break;
    if (src[i] === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    let eol = src.indexOf('\n', i);
    if (eol === -1) eol = n;
    const head = src.slice(i, eol);
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*/.exec(head);
    if (!m) throw new EzTestError(`${source}:${line}: expected KEY=value`, 'DOTENV_SYNTAX', { line });
    const key = m[1];
    i += m[0].length;
    const q = src[i];
    if (q === '"' || q === "'") {
      i++;
      let val = '';
      let closed = false;
      while (i < n) {
        const c = src[i];
        if (c === '\\' && q === '"' && i + 1 < n) {
          const e = src[i + 1];
          val += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          i += 2;
          continue;
        }
        if (c === q) {
          closed = true;
          i++;
          break;
        }
        if (c === '\n') line++;
        val += c;
        i++;
      }
      if (!closed) throw new EzTestError(`${source}:${line}: unterminated quoted value for ${key}`, 'DOTENV_SYNTAX', { line });
      // rest of line may only be whitespace or a comment
      let rest = src.indexOf('\n', i);
      if (rest === -1) rest = n;
      const tail = src.slice(i, rest).trim();
      if (tail && !tail.startsWith('#')) throw new EzTestError(`${source}:${line}: unexpected text after quoted value for ${key}`, 'DOTENV_SYNTAX', { line });
      i = rest;
      out[key] = val;
    } else {
      let end = src.indexOf('\n', i);
      if (end === -1) end = n;
      let raw = src.slice(i, end);
      const hash = raw.search(/\s#/);
      if (hash >= 0) raw = raw.slice(0, hash);
      out[key] = raw.trim();
      i = end;
    }
  }
  return out;
}

export function loadDotenvFile(path: string): Record<string, string> | undefined {
  if (!existsSync(path)) return undefined;
  return parseDotenv(readFileSync(path, 'utf8'), path);
}
