/**
 * Playwright Test importer. Reads `.spec.ts/.js` source text (never executes
 * it) and maps `test(...)` blocks to journeys: page navigation, locator
 * actions and web-first assertions become steps with the original locator kept
 * as a candidate, and expectations become post-conditions.
 */
import type { LocatorCandidate } from '../core/index.js';
import { quoteText } from '../intent/index.js';
import { JourneyDraft, oneLine, type SourceRef } from './builder.js';
import {
  ParseError, LexError, declaration, flatten, matchBracket, parseExpr, splitStatements, strOf, substitute, textOf, tokenize,
  type Expr, type Segment, type Token,
} from './code.js';
import { describeLocator, expectedCandidate, type TargetHint } from './locators.js';
import { assembleReport } from './report.js';
import type { ImportReport, ImporterOptions } from './types.js';

interface Scope {
  titles: string[];
  tags: string[];
  /** beforeEach bodies, outermost first: token ranges [start, end). */
  hooks: Array<{ start: number; end: number }>;
}

interface Ctx {
  src: string;
  toks: Token[];
  file: string;
  vars: Map<string, Expr>;
  warnings: string[];
}

const LOCATOR_METHODS = new Set(['getByRole', 'getByLabel', 'getByText', 'getByTestId', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'locator']);
const TEST_MODIFIERS = new Set(['only', 'skip', 'fixme', 'fail', 'slow']);

function q(s: string): string {
  return quoteText(s);
}

/** If tokens at `k` start `test(`, `test.only(`, `it(`, `test.describe(`... return the kind and the index of `(`. */
function blockAt(toks: Token[], k: number): { kind: 'test' | 'describe' | 'beforeEach' | 'otherHook' | 'use'; paren: number; modifier?: string } | undefined {
  let j = k;
  if (toks[j]?.v === 'await') j++;
  const a = toks[j];
  if (!a || a.t !== 'id') return undefined;
  const dot = toks[j + 1]?.v === '.';
  const b = dot ? toks[j + 2] : undefined;
  const parenIdx = dot ? j + 3 : j + 1;
  if (toks[parenIdx]?.v !== '(') {
    // test.describe.only( / test.describe.serial(
    if (dot && b?.v === 'describe' && toks[j + 3]?.v === '.' && toks[j + 5]?.v === '(') return { kind: 'describe', paren: j + 5, modifier: toks[j + 4].v };
    return undefined;
  }
  if ((a.v === 'test' || a.v === 'it') && !dot) return { kind: 'test', paren: parenIdx };
  if ((a.v === 'test' || a.v === 'it') && b && TEST_MODIFIERS.has(b.v)) return { kind: 'test', paren: parenIdx, modifier: b.v };
  if ((a.v === 'test' && b?.v === 'describe') || (a.v === 'describe' && !dot)) return { kind: 'describe', paren: parenIdx };
  if ((a.v === 'test' && b?.v === 'beforeEach') || (a.v === 'beforeEach' && !dot)) return { kind: 'beforeEach', paren: parenIdx };
  if ((a.v === 'test' && b && /^(?:afterEach|beforeAll|afterAll)$/.test(b.v)) || (!dot && /^(?:afterEach|beforeAll|afterAll)$/.test(a.v))) return { kind: 'otherHook', paren: parenIdx, modifier: b?.v ?? a.v };
  if (a.v === 'test' && b?.v === 'use') return { kind: 'use', paren: parenIdx };
  return undefined;
}

/** Find the function body `{...}` inside a call's parentheses: the brace after `=>` or `function(...)`. */
function bodyOf(toks: Token[], paren: number): { start: number; end: number } | undefined {
  const close = matchBracket(toks, paren);
  if (close < 0) return undefined;
  for (let k = paren + 1; k < close; k++) {
    if (toks[k].v === '=>' && toks[k + 1]?.v === '{') {
      const e = matchBracket(toks, k + 1);
      return e > 0 ? { start: k + 2, end: e } : undefined;
    }
    if (toks[k].v === 'function') {
      for (let j = k; j < close; j++) {
        if (toks[j].v === '{') {
          const e = matchBracket(toks, j);
          return e > 0 ? { start: j + 1, end: e } : undefined;
        }
      }
    }
  }
  return undefined;
}

function titleTags(title: string): { name: string; tags: string[] } {
  const tags = [...title.matchAll(/(?:^|\s)@([\w-]+)/g)].map((m) => m[1]);
  return { name: oneLine(title.replace(/(?:^|\s)@[\w-]+/g, ' ')) || title, tags };
}

function detailTags(e: Expr | undefined): string[] {
  if (!e || e.k !== 'obj') return [];
  const t = e.props.tag;
  if (!t) return [];
  if (t.k === 'str') return [t.v.replace(/^@/, '')];
  if (t.k === 'arr') return t.items.flatMap((i) => (i.k === 'str' ? [i.v.replace(/^@/, '')] : []));
  return [];
}

/** Import Playwright Test source text. */
export function importPlaywright(src: string, opts: ImporterOptions = {}): ImportReport {
  const file = opts.file ?? 'playwright.spec.ts';
  const ids = opts.ids ?? new Set<string>();
  const warnings: string[] = [];
  let toks: Token[];
  try {
    toks = tokenize(src, 'js');
  } catch (e) {
    return assembleReport([], [file], [], [{ file, line: 1, original: oneLine(src.slice(0, 120)), reason: `cannot read source: ${(e as LexError).message}` }]);
  }
  const ctx: Ctx = { src, toks, file, vars: new Map(), warnings };
  const drafts: JourneyDraft[] = [];
  let baseUrl: string | undefined;

  const walk = (from: number, to: number, scope: Scope) => {
    const stmts = splitStatements(toks, from, to, 'js');
    const local: Scope = { ...scope, hooks: [...scope.hooks] };
    // pass 1: constants, beforeEach hooks, test.use
    for (const s of stmts) {
      const b = blockAt(toks, s.start);
      if (b?.kind === 'beforeEach') {
        const body = bodyOf(toks, b.paren);
        if (body) local.hooks.push(body);
      } else if (b?.kind === 'use') {
        try {
          const e = parseExpr(toks, b.paren + 1, matchBracket(toks, b.paren));
          if (e.k === 'obj' && e.props.baseURL) baseUrl = strOf(e.props.baseURL) ?? baseUrl;
        } catch {
          // options other than an object literal are ignored
        }
      } else if (!b) {
        const decl = declaration(toks, s);
        if (decl && scope.titles.length === 0) {
          try {
            const v = parseExpr(toks, decl.valueStart, s.end);
            if (strOf(v) !== undefined) ctx.vars.set(decl.name, v);
          } catch {
            // not a constant
          }
        }
      }
    }
    // pass 2: tests and nested describes
    for (const s of stmts) {
      const b = blockAt(toks, s.start);
      if (!b) continue;
      const close = matchBracket(toks, b.paren);
      const titleTok = toks[b.paren + 1];
      const title = titleTok?.t === 'str' ? titleTok.v : undefined;
      if (b.kind === 'describe') {
        const body = bodyOf(toks, b.paren);
        if (!body) continue;
        const tt = title ? titleTags(title) : { name: '', tags: [] };
        walk(body.start, body.end, { titles: tt.name ? [...local.titles, tt.name] : local.titles, tags: [...local.tags, ...tt.tags], hooks: local.hooks });
      } else if (b.kind === 'otherHook') {
        warnings.push(`${file}:${toks[s.start].line}: ${b.modifier} hook not imported (only beforeEach steps are prepended to each test)`);
      } else if (b.kind === 'test') {
        const body = bodyOf(toks, b.paren);
        if (!body || !title) {
          warnings.push(`${file}:${toks[s.start].line}: test without a literal title or function body was skipped`);
          continue;
        }
        let details: Expr | undefined;
        if (toks[b.paren + 2]?.v === ',' && toks[b.paren + 3]?.v === '{') {
          const e = matchBracket(toks, b.paren + 3);
          if (e > 0 && e < close) {
            try {
              details = parseExpr(toks, b.paren + 3, e + 1);
            } catch {
              details = undefined;
            }
          }
        }
        const tt = titleTags(title);
        const tags = [...(opts.tags ?? []), ...local.tags, ...tt.tags, ...detailTags(details)];
        if (b.modifier === 'skip' || b.modifier === 'fixme') {
          tags.push('skipped');
          warnings.push(`${file}:${toks[s.start].line}: test "${tt.name}" is marked ${b.modifier} in the source`);
        }
        const name = [...local.titles, tt.name].join(' - ');
        const d = new JourneyDraft(name, { kind: 'playwright', file, line: toks[s.start].line, ids, tags, ...(baseUrl ? { baseUrl } : {}) });
        const vars = new Map(ctx.vars);
        for (const h of local.hooks) {
          d.comment('beforeEach');
          body2steps(d, { ...ctx, vars }, h.start, h.end);
        }
        if (local.hooks.length) d.comment('test');
        body2steps(d, { ...ctx, vars }, body.start, body.end);
        drafts.push(d);
      }
    }
  };
  walk(0, toks.length, { titles: [], tags: [], hooks: [] });
  if (!drafts.length) warnings.push(`${file}: no Playwright tests found`);
  return assembleReport(drafts, [file], warnings);
}

function body2steps(d: JourneyDraft, ctx: Ctx, from: number, to: number): void {
  for (const s of splitStatements(ctx.toks, from, to, 'js')) statement(d, ctx, s.start, s.end);
}

function statement(d: JourneyDraft, ctx: Ctx, start: number, end: number): void {
  try {
    statementInner(d, ctx, start, end);
  } catch (e) {
    d.addTodo({ line: ctx.toks[start].line, original: textOf(ctx.src, ctx.toks, { start, end }) }, `conversion error: ${(e as Error).message}`);
  }
}

function statementInner(d: JourneyDraft, ctx: Ctx, start: number, end: number): void {
  const { toks } = ctx;
  const original = textOf(ctx.src, toks, { start, end });
  const src: SourceRef = { line: toks[start].line, original };
  const first = toks[start];
  if (first.t === 'id' && /^(?:if|for|while|do|switch|try|return|throw)$/.test(first.v)) {
    d.addTodo(src, `control flow ("${first.v}") is not converted`);
    return;
  }
  // test.step('title', async () => { ... })
  const k0 = first.v === 'await' ? start + 1 : start;
  if (toks[k0]?.v === 'test' && toks[k0 + 1]?.v === '.' && toks[k0 + 2]?.v === 'step' && toks[k0 + 3]?.v === '(') {
    const t = toks[k0 + 4];
    const body = bodyOf(toks, k0 + 3);
    if (body) {
      d.comment(`Step: ${t?.t === 'str' ? t.v : 'unnamed'}`);
      body2steps(d, ctx, body.start, body.end);
      return;
    }
  }
  const decl = declaration(toks, { start, end });
  let expr: Expr;
  try {
    expr = parseExpr(toks, decl ? decl.valueStart : start, end);
  } catch (e) {
    d.addTodo(src, `cannot parse statement: ${(e as ParseError).message}`);
    return;
  }
  expr = substitute(expr, ctx.vars);
  if (decl) {
    // Locator or string bindings are remembered, not steps.
    if (strOf(expr) !== undefined || isLocatorExpr(expr)) {
      ctx.vars.set(decl.name, expr);
      return;
    }
    const cap = captureOf(expr);
    if (cap) {
      const desc = describeLocator(cap.cand, 'generic');
      if (!desc) {
        d.addTodo(src, 'locator cannot be expressed in .ez');
        return;
      }
      d.step(`Capture the ${cap.mode} of ${desc} as ${decl.name}`, src, { action: 'capture', candidate: expectedCandidate(cap.cand, desc) });
      ctx.vars.set(decl.name, { k: 'str', v: `\${${decl.name}}` });
      return;
    }
  }
  convert(d, ctx, expr, src);
}

/** Resolve a Playwright locator chain to a candidate. Returns the index after the locator segment. */
function locatorOf(segs: Segment[]): { cand: LocatorCandidate; next: number } | { error: string } | undefined {
  let i = 0;
  if (segs[0]?.name === 'this' && segs[1]?.name === 'page') i = 1;
  if (segs[i]?.name !== 'page' || segs[i].call) return undefined;
  const loc = segs[i + 1];
  if (!loc || !loc.call || !loc.name || !LOCATOR_METHODS.has(loc.name)) return undefined;
  const after = segs[i + 2];
  if (after?.name && (LOCATOR_METHODS.has(after.name) || /^(?:first|last|nth|filter|and|or|frameLocator|locator)$/.test(after.name))) {
    return { error: `chained locator ".${loc.name}(...).${after.name}(...)" is not converted (EZTest targets must resolve to exactly one element)` };
  }
  const a0 = loc.args[0];
  const o = loc.args[1]?.k === 'obj' ? loc.args[1].props : {};
  const s0 = strOf(a0);
  if (a0?.k === 're') return { error: `regular-expression locator /${a0.source}/ is not converted` };
  if (s0 === undefined) return { error: `locator argument is not a literal string` };
  const exact = o.exact?.k === 'lit' ? o.exact.v === true : undefined;
  let cand: LocatorCandidate;
  switch (loc.name) {
    case 'getByRole': {
      const nm = o.name;
      if (nm?.k === 're') return { error: 'role locator with a regular-expression name is not converted' };
      const name = strOf(nm);
      if (nm && name === undefined) return { error: 'role locator name is not a literal string' };
      cand = name !== undefined ? { strategy: 'role', value: s0, name } : { strategy: 'role', value: s0 };
      break;
    }
    case 'getByLabel': cand = { strategy: 'label', value: s0 }; break;
    case 'getByText': cand = { strategy: 'text', value: s0, exact: exact === true }; break;
    case 'getByTestId': cand = { strategy: 'testId', value: s0 }; break;
    case 'getByPlaceholder': cand = { strategy: 'placeholder', value: s0 }; break;
    case 'getByAltText': cand = { strategy: 'altText', value: s0 }; break;
    case 'getByTitle': cand = { strategy: 'title', value: s0 }; break;
    default: cand = selectorCandidate(s0);
  }
  return { cand, next: i + 2 };
}

/** A Playwright selector string as a candidate. */
export function selectorCandidate(sel: string): LocatorCandidate {
  const s = sel.trim();
  if (/^xpath=/i.test(s)) return { strategy: 'xpath', value: s.replace(/^xpath=/i, '') };
  if (/^\(?\/\//.test(s)) return { strategy: 'xpath', value: s };
  if (/^css=/i.test(s)) return { strategy: 'css', value: s.replace(/^css=/i, '') };
  return { strategy: 'css', value: s };
}

function isLocatorExpr(e: Expr): boolean {
  const segs = flatten(e);
  const r = locatorOf(segs);
  return !!r && 'cand' in r && r.next === segs.length;
}

function captureOf(e: Expr): { cand: LocatorCandidate; mode: 'text' | 'value' } | undefined {
  const segs = flatten(e);
  const r = locatorOf(segs);
  if (!r || !('cand' in r) || r.next !== segs.length - 1) return undefined;
  const m = segs[r.next];
  if (!m.call) return undefined;
  if (m.name === 'textContent' || m.name === 'innerText') return { cand: r.cand, mode: 'text' };
  if (m.name === 'inputValue') return { cand: r.cand, mode: 'value' };
  return undefined;
}

function hintFor(action: string): TargetHint {
  if (/^(?:fill|type|pressSequentially|clear|press|setInputFiles)$/.test(action)) return 'field';
  if (action === 'selectOption') return 'dropdown';
  if (/^(?:check|uncheck|setChecked)$/.test(action)) return 'checkbox';
  if (/^(?:click|dblclick)$/.test(action)) return 'click';
  return 'generic';
}

function keyText(k: string): string {
  return /^[A-Za-z0-9+]+$/.test(k) ? k : q(k);
}

/** Glob URL pattern (Playwright `**` style) to a regular expression source. */
export function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '.';
    else out += c.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
  }
  return `^${out}$`;
}

/** URL expectation phrase for a string (exact or glob) or regex argument. */
function urlPhrase(arg: Expr | undefined): string | { error: string } {
  if (arg?.k === 're') {
    if (arg.flags.replace(/[gsuy]/g, '')) return { error: `URL regex flags "${arg.flags}" cannot be expressed` };
    return `the URL matches ${q(arg.source)}`;
  }
  const s = strOf(arg);
  if (s === undefined) return { error: 'URL argument is not a literal' };
  if (/[*?]/.test(s)) return `the URL matches ${q(globToRegex(s))}`;
  return `the URL is ${q(s)}`;
}

function convert(d: JourneyDraft, ctx: Ctx, expr: Expr, src: SourceRef): void {
  const segs = flatten(expr);
  if (segs[0]?.name === 'expect' && !segs[0].call && segs[1]?.name === 'soft') return expectation(d, [{ ...segs[1], name: 'expect' }, ...segs.slice(2)], src);
  if (segs[0]?.name === 'expect') return expectation(d, segs, src);

  const loc = locatorOf(segs);
  if (loc && 'error' in loc) {
    d.addTodo(src, loc.error);
    return;
  }
  if (loc) {
    const act = segs[loc.next];
    if (!act || !act.call || !act.name || loc.next !== segs.length - 1) {
      d.addTodo(src, 'locator statement without a supported action');
      return;
    }
    return locatorAction(d, loc.cand, act, src);
  }
  // page-level calls
  let i = 0;
  if (segs[0]?.name === 'this' && segs[1]?.name === 'page') i = 1;
  if (segs[i]?.name === 'page' && !segs[i].call) {
    const rest = segs.slice(i + 1);
    const m = rest[0];
    if (rest.length === 2 && m.name === 'keyboard' && rest[1].name === 'press' && rest[1].call) {
      const k = strOf(rest[1].args[0]);
      if (k === undefined) return void d.addTodo(src, 'key is not a literal');
      d.step(`Press ${keyText(k)}`, src, { action: 'press', value: k });
      return;
    }
    if (rest.length === 1 && m.call) {
      const a0 = strOf(m.args[0]);
      switch (m.name) {
        case 'goto':
          if (a0 === undefined) return void d.addTodo(src, 'URL is not a literal');
          d.step(`Open ${q(a0)}`, src, { action: 'navigate', value: a0 });
          return;
        case 'reload': d.step('Reload the page', src, { action: 'navigate' }); return;
        case 'goBack': d.step('Go back', src, { action: 'navigate' }); return;
        case 'goForward': d.step('Go forward', src, { action: 'navigate' }); return;
        case 'waitForTimeout': {
          const ms = m.args[0]?.k === 'num' ? m.args[0].v : undefined;
          if (ms === undefined) return void d.addTodo(src, 'timeout is not a literal number');
          d.step(`Wait ${Math.round(ms)} ms`, src, { action: 'wait' });
          return;
        }
        case 'waitForURL': {
          const p = urlPhrase(m.args[0]);
          if (typeof p !== 'string') return void d.addTodo(src, p.error, 'assertion');
          d.expect(p, src);
          return;
        }
        case 'waitForSelector': {
          if (a0 === undefined) return void d.addTodo(src, 'selector is not a literal');
          const cand = selectorCandidate(a0);
          const desc = describeLocator(cand);
          if (!desc) return void d.addTodo(src, 'selector cannot be expressed in .ez');
          d.step(`Wait for ${desc}`, src, { action: 'wait', candidate: expectedCandidate(cand, desc) });
          return;
        }
        default:
          // Legacy page.click(selector) / page.fill(selector, value) API.
          if (a0 !== undefined && /^(?:click|dblclick|fill|type|check|uncheck|selectOption|hover|press|setInputFiles)$/.test(m.name ?? '')) {
            return locatorAction(d, selectorCandidate(a0), { ...m, args: m.args.slice(1) }, src);
          }
      }
    }
    d.addTodo(src, `page.${rest.map((r) => r.name ?? '?').join('.')} is not converted`);
    return;
  }
  d.addTodo(src, 'statement is not a Playwright page/locator call');
}

function locatorAction(d: JourneyDraft, cand: LocatorCandidate, act: Segment, src: SourceRef): void {
  const name = act.name ?? '';
  const desc = describeLocator(cand, hintFor(name));
  if (!desc) return void d.addTodo(src, `locator ${cand.strategy}=${JSON.stringify(cand.value)} cannot be expressed in .ez`);
  const candidate = expectedCandidate(cand, desc);
  const a0 = act.args[0];
  const s0 = strOf(a0);
  const opts = act.args[act.args.length - 1]?.k === 'obj' ? (act.args[act.args.length - 1] as { props: Record<string, Expr> }).props : {};
  switch (name) {
    case 'click': {
      const button = strOf(opts.button);
      const count = opts.clickCount?.k === 'num' ? opts.clickCount.v : 1;
      if (count === 2) return void d.step(`Double-click ${desc}`, src, { action: 'dblclick', candidate });
      if (button === 'right') return void d.step(`Right-click ${desc}`, src, { action: 'click', candidate });
      if (button && button !== 'left') return void d.addTodo(src, `click with button "${button}" is not converted`);
      return void d.step(`Click ${desc}`, src, { action: 'click', candidate });
    }
    case 'dblclick': return void d.step(`Double-click ${desc}`, src, { action: 'dblclick', candidate });
    case 'fill':
    case 'type':
    case 'pressSequentially':
      if (s0 === undefined) return void d.addTodo(src, 'value is not a literal string');
      return void d.step(`Type ${q(s0)} into ${desc}`, src, { action: 'fill', value: s0, candidate });
    case 'clear': return void d.step(`Clear ${desc}`, src, { action: 'clear', candidate });
    case 'check': return void d.step(`Check ${desc}`, src, { action: 'check', candidate });
    case 'uncheck': return void d.step(`Uncheck ${desc}`, src, { action: 'uncheck', candidate });
    case 'setChecked': {
      const on = a0?.k === 'lit' ? a0.v : undefined;
      if (typeof on !== 'boolean') return void d.addTodo(src, 'setChecked argument is not a literal boolean');
      return void d.step(`${on ? 'Check' : 'Uncheck'} ${desc}`, src, { action: on ? 'check' : 'uncheck', candidate });
    }
    case 'hover': return void d.step(`Hover over ${desc}`, src, { action: 'hover', candidate });
    case 'press':
      if (s0 === undefined) return void d.addTodo(src, 'key is not a literal');
      return void d.step(`Press ${keyText(s0)} in ${desc}`, src, { action: 'press', value: s0, candidate });
    case 'setInputFiles':
      if (s0 === undefined) return void d.addTodo(src, 'file path is not a literal (or several files were given)');
      return void d.step(`Upload ${q(s0)} to ${desc}`, src, { action: 'upload', value: s0, candidate });
    case 'selectOption': {
      let v = s0;
      if (a0?.k === 'obj') v = strOf(a0.props.label) ?? strOf(a0.props.value);
      if (a0?.k === 'arr' && a0.items.length === 1) v = strOf(a0.items[0]);
      if (v === undefined) return void d.addTodo(src, 'option is not a single literal (multi-select and index selection are not converted)');
      return void d.step(`Select ${q(v)} from ${desc}`, src, { action: 'select', value: v, candidate });
    }
    case 'waitFor': {
      const state = strOf(opts.state);
      if (state === 'hidden' || state === 'detached') return void d.step(`Wait for ${desc} to disappear`, src, { action: 'wait' });
      if (state && state !== 'visible' && state !== 'attached') return void d.addTodo(src, `waitFor state "${state}" is not converted`);
      return void d.step(`Wait for ${desc}`, src, { action: 'wait', candidate });
    }
    default:
      d.addTodo(src, `locator action ".${name}()" is not converted`);
  }
}

/** Simple literal regex (no metacharacters) as plain text, else undefined. */
function literalRegex(e: Expr | undefined): string | undefined {
  if (e?.k !== 're' || e.flags.replace(/[gu]/g, '')) return undefined;
  const unesc = e.source.replace(/\\([./\-()[\]?*+{}$^|])/g, '$1');
  return /[\\.*+?()[\]{}^$|]/.test(e.source.replace(/\\[./\-()[\]?*+{}$^|]/g, '')) ? undefined : unesc;
}

function expectation(d: JourneyDraft, segs: Segment[], src: SourceRef): void {
  const head = segs[0];
  if (!head.call || head.args.length < 1) return void d.addTodo(src, 'expect() without a subject', 'assertion');
  let rest = segs.slice(1);
  let negated = false;
  if (rest[0]?.name === 'not' && !rest[0].call) {
    negated = true;
    rest = rest.slice(1);
  }
  if (rest[0]?.name === 'resolves' || rest[0]?.name === 'rejects') return void d.addTodo(src, 'promise matchers are not converted', 'assertion');
  const matcher = rest[0];
  if (!matcher || !matcher.call || rest.length !== 1) return void d.addTodo(src, 'unsupported expect() form', 'assertion');
  const m = matcher.name ?? '';
  const arg = matcher.args[0];
  const subject = head.args[0];
  const subjSegs = flatten(subject);

  // expect(page)
  if ((subjSegs.length === 1 && subjSegs[0].name === 'page') || (subjSegs.length === 2 && subjSegs[0].name === 'this' && subjSegs[1].name === 'page')) {
    if (m === 'toHaveURL') {
      if (negated) return void d.addTodo(src, 'negated URL expectation is not converted', 'assertion');
      const p = urlPhrase(arg);
      if (typeof p !== 'string') return void d.addTodo(src, p.error, 'assertion');
      return void d.expect(p, src);
    }
    if (m === 'toHaveTitle') {
      if (negated) return void d.addTodo(src, 'negated title expectation is not converted', 'assertion');
      const t = strOf(arg) ?? literalRegex(arg);
      if (t === undefined) return void d.addTodo(src, 'title pattern cannot be expressed (only literal text)', 'assertion');
      return void d.expect(`the title contains ${q(t)}`, src, { type: 'titleContains' });
    }
    return void d.addTodo(src, `page matcher ${m} is not converted`, 'assertion');
  }

  // expect(capturedValue).toBe('x')
  if (subject.k === 'str' && /^\$\{[\w.]+\}$/.test(subject.v)) {
    const key = subject.v.slice(2, -1);
    const v = strOf(arg);
    if ((m === 'toBe' || m === 'toEqual') && v !== undefined && !negated) return void d.expect(`\${${key}} equals ${q(v)}`, src, { type: 'ledgerEquals' });
    return void d.addTodo(src, `value matcher ${m} is not converted`, 'assertion');
  }

  const loc = locatorOf(subjSegs);
  if (!loc) return void d.addTodo(src, 'expect() subject is not a page or locator', 'assertion');
  if ('error' in loc) return void d.addTodo(src, loc.error, 'assertion');
  if (loc.next !== subjSegs.length) return void d.addTodo(src, 'expect() subject is not a plain locator', 'assertion');
  const desc = describeLocator(loc.cand, m === 'toHaveValue' ? 'field' : 'generic');
  if (!desc) return void d.addTodo(src, 'locator cannot be expressed in .ez', 'assertion');
  const candidate = expectedCandidate(loc.cand, desc);
  const s = strOf(arg);
  switch (m) {
    case 'toBeVisible':
      if (arg?.k === 'obj' && arg.props.visible?.k === 'lit' && arg.props.visible.v === false) negated = !negated;
      return void d.expect(`${desc} is ${negated ? 'hidden' : 'visible'}`, src, { type: negated ? 'hidden' : 'visible', candidate });
    case 'toBeHidden':
      return void d.expect(`${desc} is ${negated ? 'visible' : 'hidden'}`, src, { type: negated ? 'visible' : 'hidden', candidate });
    case 'toHaveText':
    case 'toContainText': {
      if (negated) return void d.addTodo(src, `negated ${m} is not converted`, 'assertion');
      if (s !== undefined) {
        return m === 'toHaveText'
          ? void d.expect(`${desc} has text ${q(s)}`, src, { type: 'textEquals', candidate })
          : void d.expect(`${desc} contains ${q(s)}`, src, { type: 'textContains', candidate });
      }
      const lit = literalRegex(arg);
      if (lit !== undefined) return void d.expect(`${desc} contains ${q(lit)}`, src, { type: 'textContains', candidate });
      return void d.addTodo(src, `${m} with a pattern or list is not converted`, 'assertion');
    }
    case 'toHaveValue':
      if (negated || s === undefined) return void d.addTodo(src, 'toHaveValue needs a literal and no negation', 'assertion');
      return void d.expect(`${desc} has value ${q(s)}`, src, { type: 'valueEquals', candidate });
    case 'toHaveCount': {
      if (negated || arg?.k !== 'num') return void d.addTodo(src, 'toHaveCount needs a literal number and no negation', 'assertion');
      return void d.expect(`the number of ${desc} is ${arg.v}`, src, { type: 'count', candidate });
    }
    default:
      return void d.addTodo(src, `no EZ condition for ${negated ? 'not.' : ''}${m}`, 'assertion');
  }
}
