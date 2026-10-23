/**
 * Step outline of an `.ez` journey with line numbers and block nesting, for
 * the debugger: which line is which step (top-level index or nested step id),
 * how blocks (If, loops, Try, groups, frame blocks) nest, and the line range
 * of each step with its expectations. It follows the `.ez` parser's own block
 * rules (a line opens a block when it parses to a block action with no inline
 * children; End / Otherwise / On failure lines structure it) and gives steps
 * the same document-order ids, so debugger events map back to lines.
 */
import { BLOCK_ACTIONS } from '../core/index.js';
import { matchesPluginRule, parseIntent } from '../intent/index.js';

const HEADER = /^(journey|name|id|tags|role|requirements?|risk|base\s*url|variables|vars|description|lenses|data|params|parameters|returns|device|viewport|locale|time\s*zone|colou?r\s*scheme|reduced\s*motion|geolocation|permissions|user\s*agent|touch|offline|http\s*credentials|extra\s*headers|headers|actors|browsers|locks?|platform|app|capabilities|loaders|requires|depends\s*on)\s*:\s*(.*)$/i;
const EXPECT = /^(?:(?:then|and|also)\s+)?(?:expect|verify)\s+(?:that\s+)?(.+)$/i;
const SOFT = /^(?:(?:then|and|also)\s+)?(?:(?:expect|verify)\s+softly|soft(?:ly)?\s+(?:expect|verify))\b/i;
const END = /^(?:end(?:\s+(?:if|unless|repeat|for(?:\s+each)?|each|loop|while|retry|try|group|frame|in\s+frame|block|journey))?|done|next|endif)\s*[.;]?$/i;
const BRANCH = /^(?:otherwise|else|on\s+(?:failure|error)|if\s+(?:it|that|this)\s+fails|catch|when\s+it\s+fails)\b.*$/i;
const EXAMPLES = /^(?:examples|scenarios|data\s+table)\s*:\s*$/i;

export interface OutlineEntry {
  /** Position in the outline (document order). */
  pos: number;
  /** 1-based first line (the step line) and last line (its expectations). */
  line: number;
  endLine: number;
  text: string;
  expects: string[];
  id: string;
  action: string;
  /** Nesting depth (0: a top-level step of the journey). */
  depth: number;
  /** Index in `journey.steps` (top-level steps only). */
  index?: number;
  /** `pos` of the enclosing block step. */
  parent?: number;
  block: boolean;
}

export interface Outline {
  ok: boolean;
  entries: OutlineEntry[];
  error?: string;
}

export function debugOutline(text: string): Outline {
  const lines = text.split(/\r?\n/);
  const entries: OutlineEntry[] = [];
  const ids = new Map<string, number>();
  const stack: number[] = [];
  const sections = new Set<number>();
  const indents = new Map<number, number>();
  const contentIndents = new Map<number, number>();
  const indentOf = (l: string) => l.length - l.trimStart().length;
  let top = 0;
  let headers = true;
  let error: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    if (/^(?:examples|scenarios|data\s+table)\s*:\s*from\s/i.test(t)) continue; // external Examples source
    if (EXAMPLES.test(t)) {
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) i++;
      continue;
    }
    if (headers && !stack.length && HEADER.test(t)) continue;
    headers = false;
    if (!END.test(t)) {
      // An indented As section ends at the first line not indented deeper than its As line (as in the parser).
      const ind = indentOf(lines[i]);
      while (stack.length && sections.has(stack[stack.length - 1])) {
        const top = stack[stack.length - 1];
        if (!contentIndents.has(top)) contentIndents.set(top, ind);
        if (contentIndents.get(top)! > (indents.get(top) ?? 0) && ind <= (indents.get(top) ?? 0)) entries[stack.pop()!].endLine = i;
        else break;
      }
    }
    if (END.test(t)) {
      let open = stack.pop();
      // An End indented less than the As line it would close ends that As section and the enclosing block (as in the parser).
      if (open !== undefined && sections.has(open) && stack.length && indentOf(lines[i]) < (indents.get(open) ?? 0)) {
        entries[open].endLine = i;
        open = stack.pop();
      }
      if (open !== undefined) entries[open].endLine = i + 1;
      continue;
    }
    if (stack.length && BRANCH.test(t) && !/\bthen\s*$/i.test(t)) continue;
    const prev = entries[entries.length - 1];
    const sameList = prev && prev.depth === stack.length && (stack.length ? prev.parent === stack[stack.length - 1] : true);
    if (!SOFT.test(t) && EXPECT.test(t) && prev && !matchesPluginRule(t)) {
      // An expectation of the last step in the current list (or of the open block itself).
      const parent = stack.length ? stack[stack.length - 1] : undefined;
      const owner = sameList ? prev : [...entries].reverse().find((x) => x.depth === stack.length && x.parent === parent) ?? (parent !== undefined ? entries[parent] : prev);
      owner.expects.push(EXPECT.exec(t)![1]);
      if (!owner.block) owner.endLine = i + 1;
      continue;
    }
    type Parsed = { id: string; action: string; steps?: Parsed[]; else?: Parsed[]; catch?: Parsed[] };
    let step: Parsed;
    try {
      step = parseIntent(t, { lineNumber: i + 1 }) as typeof step;
    } catch (e) {
      error ??= `line ${i + 1}: ${(e as Error).message.replace(/^line \d+:\s*/, '')}`;
      continue;
    }
    const n = (ids.get(step.id) ?? 0) + 1;
    ids.set(step.id, n);
    const id = n > 1 ? `${step.id}-${n}` : step.id;
    // Inline children (one-liners such as "Repeat 3 times: press Tab") take ids too, as in the parser.
    const inline = (s: Parsed) => {
      for (const c of [...(s.steps ?? []), ...(s.else ?? []), ...(s.catch ?? [])]) {
        ids.set(c.id, (ids.get(c.id) ?? 0) + 1);
        inline(c);
      }
    };
    inline(step);
    const block = BLOCK_ACTIONS.has(step.action) && Array.isArray(step.steps) && step.steps.length === 0;
    // "As <actor>:" sections end at the next As / Switch to user line of the same list (as in the parser).
    if (step.action === 'actor' && stack.length && sections.has(stack[stack.length - 1])) {
      const open = stack.pop()!;
      entries[open].endLine = i;
    }
    const e: OutlineEntry = {
      pos: entries.length, line: i + 1, endLine: i + 1, text: t, expects: [], id, action: step.action, depth: stack.length, block,
      ...(stack.length ? { parent: stack[stack.length - 1] } : { index: top++ }),
    };
    entries.push(e);
    if (block) stack.push(e.pos);
    if (block && step.action === 'actor') {
      sections.add(e.pos);
      indents.set(e.pos, indentOf(lines[i]));
    }
  }
  // As sections still open at the end of the file end there.
  while (stack.length && sections.has(stack[stack.length - 1])) entries[stack.pop()!].endLine = lines.length;
  return { ok: !error && !stack.length, entries, ...(error ? { error } : stack.length ? { error: 'a block has no matching "End"' } : {}) };
}
