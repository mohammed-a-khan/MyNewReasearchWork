/**
 * Selenium WebDriver importer for the common Java (JUnit/TestNG), C#
 * (NUnit/MSTest/xUnit) and Python (unittest/pytest) forms. Source text is
 * parsed, never executed. `driver.get`, `findElement(By...)` actions,
 * `Select` helpers, explicit waits and the usual assertion styles become EZ
 * steps; locators are preserved as candidates.
 */
import type { LocatorCandidate } from '../core/index.js';
import { quoteText } from '../intent/index.js';
import { JourneyDraft, oneLine, type SourceRef } from './builder.js';
import {
  LexError, ParseError, declaration, dotted, flatten, humanize, matchBracket, parseExpr, splitStatements, strOf, substitute, textOf, tokenize,
  type Expr, type Lang, type Stmt, type Token,
} from './code.js';
import { cssEscapeId, describeLocator, expectedCandidate, type TargetHint } from './locators.js';
import { assembleReport } from './report.js';
import type { ImportReport, ImporterOptions } from './types.js';

export interface SeleniumOptions extends ImporterOptions {
  /** Source language; default from the file extension (.java, .cs, .py), else sniffed. */
  language?: 'java' | 'cs' | 'py';
}

interface Method {
  name: string;
  kind: 'test' | 'setup' | 'teardown';
  line: number;
  body: { start: number; end: number };
  tags: string[];
  /** Python: the def's column (setUp applies to tests in the same class). */
  col: number;
}

interface Ctx {
  src: string;
  toks: Token[];
  lang: Lang;
  file: string;
  vars: Map<string, Expr>;
  warnings: string[];
}

const q = (s: string) => quoteText(s);

export function detectSeleniumLanguage(src: string, file?: string): 'java' | 'cs' | 'py' {
  if (file?.endsWith('.java')) return 'java';
  if (file?.endsWith('.cs')) return 'cs';
  if (file?.endsWith('.py')) return 'py';
  if (/^\s*(?:from|import)\s+selenium/m.test(src) || /\bdef\s+test/.test(src)) return 'py';
  if (/\busing\s+OpenQA\.Selenium/.test(src) || /\[(?:Test|TestMethod|Fact)\]/.test(src)) return 'cs';
  return 'java';
}

// ------------------------------------------------------------------ test discovery

const JAVA_TEST = /^(?:Test|ParameterizedTest|RepeatedTest)$/;
const JAVA_SETUP = /^(?:Before|BeforeEach|BeforeMethod)$/;
const JAVA_TEARDOWN = /^(?:After|AfterEach|AfterMethod|AfterClass|AfterAll|BeforeClass|BeforeAll)$/;
const CS_TEST = /^(?:Test|TestMethod|Fact|Theory|TestCase)$/;
const CS_SETUP = /^(?:SetUp|TestInitialize)$/;
const CS_TEARDOWN = /^(?:TearDown|TestCleanup|OneTimeSetUp|OneTimeTearDown|ClassInitialize|ClassCleanup)$/;

/** After annotations, find `name(...) ... {` and return the method name and body. */
function methodAfter(toks: Token[], from: number): { name: string; body: { start: number; end: number }; next: number } | undefined {
  for (let k = from; k < toks.length && k < from + 60; k++) {
    if (toks[k].t === 'p' && (toks[k].v === ';' || toks[k].v === '}')) return undefined;
    if (toks[k].t === 'id' && toks[k + 1]?.v === '(') {
      const close = matchBracket(toks, k + 1);
      if (close < 0) return undefined;
      for (let j = close + 1; j < toks.length; j++) {
        if (toks[j].v === ';') return undefined;
        if (toks[j].v === '{') {
          const end = matchBracket(toks, j);
          return end > 0 ? { name: toks[k].v, body: { start: j + 1, end }, next: end + 1 } : undefined;
        }
      }
      return undefined;
    }
  }
  return undefined;
}

function braceMethods(toks: Token[], lang: 'java' | 'cs'): Method[] {
  const out: Method[] = [];
  let k = 0;
  while (k < toks.length) {
    let kind: Method['kind'] | undefined;
    const tags: string[] = [];
    const startLine = toks[k].line;
    let j = k;
    // collect consecutive annotations / attributes
    for (;;) {
      if (lang === 'java' && toks[j]?.v === '@' && toks[j + 1]?.t === 'id') {
        let nmEnd = j + 1;
        while (toks[nmEnd + 1]?.v === '.' && toks[nmEnd + 2]?.t === 'id') nmEnd += 2;
        const nm = toks[nmEnd].v;
        let after = nmEnd + 1;
        if (toks[after]?.v === '(') {
          const c = matchBracket(toks, after);
          if (nm === 'Tag' || nm === 'Tags') for (let x = after; x < c; x++) if (toks[x].t === 'str') tags.push(toks[x].v);
          if (nm === 'Test') for (let x = after; x < c; x++) if (toks[x].v === 'groups') for (let y = x; y < c; y++) if (toks[y].t === 'str') tags.push(toks[y].v);
          after = c + 1;
        }
        if (JAVA_TEST.test(nm)) kind = 'test';
        else if (JAVA_SETUP.test(nm)) kind ??= 'setup';
        else if (JAVA_TEARDOWN.test(nm)) kind ??= 'teardown';
        j = after;
        continue;
      }
      if (lang === 'cs' && toks[j]?.v === '[' && toks[j + 1]?.t === 'id' && (toks[j].nl || toks[j - 1]?.v === ']')) {
        const c = matchBracket(toks, j);
        if (c < 0) break;
        let x = j + 1;
        let any = false;
        while (x < c) {
          const nm = toks[x].v.replace(/Attribute$/, '');
          if (toks[x].t === 'id') {
            if (CS_TEST.test(nm)) (kind = 'test'), (any = true);
            else if (CS_SETUP.test(nm)) (kind ??= 'setup'), (any = true);
            else if (CS_TEARDOWN.test(nm)) (kind ??= 'teardown'), (any = true);
            else if (nm === 'Category' || nm === 'TestCategory' || nm === 'Trait') any = true;
            if ((nm === 'Category' || nm === 'TestCategory' || nm === 'Trait') && toks[x + 1]?.v === '(') {
              const cc = matchBracket(toks, x + 1);
              const strs: string[] = [];
              for (let y = x + 1; y < cc; y++) if (toks[y].t === 'str') strs.push(toks[y].v);
              tags.push(strs[strs.length - 1] ?? '');
              x = cc;
            }
          }
          if (toks[x + 1]?.v === '(') x = matchBracket(toks, x + 1);
          x++;
        }
        if (!any) break;
        j = c + 1;
        continue;
      }
      break;
    }
    if (kind) {
      const m = methodAfter(toks, j);
      if (m) {
        out.push({ name: m.name, kind, line: startLine, body: m.body, tags: tags.filter(Boolean), col: 0 });
        k = m.body.start;
        continue;
      }
    }
    k = j > k ? j : k + 1;
  }
  return out;
}

function pythonMethods(toks: Token[]): Method[] {
  const out: Method[] = [];
  for (let k = 0; k < toks.length; k++) {
    if (!(toks[k].v === 'def' && toks[k].t === 'id' && toks[k].nl)) continue;
    const name = toks[k + 1]?.v ?? '';
    const kind: Method['kind'] | undefined = /^test/.test(name) ? 'test' : /^(?:setUp|setup_method|setup)$/.test(name) ? 'setup' : /^(?:tearDown|teardown_method|teardown)$/.test(name) ? 'teardown' : undefined;
    if (!kind) continue;
    const col = toks[k].col;
    const close = matchBracket(toks, k + 2);
    if (close < 0) continue;
    let colon = close + 1;
    while (colon < toks.length && toks[colon].v !== ':') colon++;
    let end = colon + 1;
    while (end < toks.length && !(toks[end].nl && toks[end].col <= col)) end++;
    // decorators above: @pytest.mark.smoke
    const tags: string[] = [];
    let line = toks[k].line;
    let b = k - 1;
    while (b >= 0) {
      let s = b;
      while (s > 0 && !toks[s].nl) s--;
      if (toks[s].v !== '@') break;
      const seg = toks.slice(s, b + 1).map((t) => t.v);
      const mi = seg.indexOf('mark');
      if (mi >= 0 && seg[mi + 2] && seg[mi + 2] !== 'parametrize') tags.push(seg[mi + 2]);
      line = toks[s].line;
      b = s - 1;
    }
    out.push({ name, kind, line, body: { start: colon + 1, end }, tags, col });
  }
  return out;
}

// ------------------------------------------------------------------ locators

const BY_KINDS: Record<string, string> = {
  id: 'id', name: 'name', cssselector: 'css', css_selector: 'css', 'css selector': 'css', xpath: 'xpath',
  linktext: 'linkText', link_text: 'linkText', 'link text': 'linkText', partiallinktext: 'partialLinkText',
  partial_link_text: 'partialLinkText', 'partial link text': 'partialLinkText', classname: 'className', class_name: 'className',
  'class name': 'className', tagname: 'tagName', tag_name: 'tagName', 'tag name': 'tagName',
};

export function byCandidate(kind: string, value: string): LocatorCandidate | undefined {
  switch (BY_KINDS[kind.toLowerCase()]) {
    case 'id': return { strategy: 'css', value: `#${cssEscapeId(value)}` };
    case 'name': return value.includes('"') ? undefined : { strategy: 'css', value: `[name="${value}"]` };
    case 'css': return { strategy: 'css', value };
    case 'xpath': return { strategy: 'xpath', value };
    case 'linkText': return { strategy: 'role', value: 'link', name: value };
    case 'partialLinkText': return value.includes('"') ? undefined : { strategy: 'css', value: `a:has-text("${value}")` };
    case 'className': return { strategy: 'css', value: `.${value.trim().split(/\s+/).map(cssEscapeId).join('.')}` };
    case 'tagName': return { strategy: 'css', value };
    default: return undefined;
  }
}

/** A `By` locator expression: By.id("x"), By.Id("x"), (By.ID, "x"), ("id", "x"). */
function byOf(args: Expr[], vars: Map<string, Expr>): LocatorCandidate | { error: string } | undefined {
  if (args.length === 1 && args[0].k === 'arr') return byOf(args[0].items, vars);
  if (args.length === 1 && args[0].k === 'call') {
    const segs = flatten(args[0]);
    if (segs.length === 2 && segs[0].name === 'By' && segs[1].call && segs[1].name) {
      const v = strOf(segs[1].args[0], vars);
      if (v === undefined) return { error: 'locator value is not a literal string' };
      return byCandidate(segs[1].name, v) ?? { error: `By.${segs[1].name} is not supported` };
    }
    return undefined;
  }
  if (args.length === 2) {
    const kindName = args[0].k === 'str' ? args[0].v : dotted(args[0])?.replace(/^By\./, '');
    const v = strOf(args[1], vars);
    if (!kindName) return undefined;
    if (v === undefined) return { error: 'locator value is not a literal string' };
    return byCandidate(kindName, v) ?? { error: `locator kind "${kindName}" is not supported` };
  }
  return undefined;
}

const FIND = /^(?:findElement|find_element|FindElement)$/;
const FIND_BY = /^find_element_by_(id|name|xpath|css_selector|link_text|partial_link_text|class_name|tag_name)$/;
const EC_ELEMENT = /^(?:visibilityOfElementLocated|presenceOfElementLocated|elementToBeClickable|visibility_of_element_located|presence_of_element_located|element_to_be_clickable|ElementIsVisible|ElementExists|ElementToBeClickable)$/;

/** Resolve an element-producing expression to a candidate. */
function elementOf(e: Expr, vars: Map<string, Expr>): LocatorCandidate | { error: string } | undefined {
  if (e.k !== 'call') return undefined;
  const fn = e.fn;
  if (fn.k !== 'member') return undefined;
  if (FIND.test(fn.name)) {
    if (elementOf(fn.obj, vars)) return { error: 'nested findElement chains are not converted' };
    return byOf(e.args, vars) ?? { error: 'unrecognised By locator' };
  }
  const fb = FIND_BY.exec(fn.name);
  if (fb) {
    const v = strOf(e.args[0], vars);
    if (v === undefined) return { error: 'locator value is not a literal string' };
    return byCandidate(fb[1], v) ?? { error: `${fn.name} is not supported` };
  }
  if (/^(?:findElements|find_elements|FindElements)$/.test(fn.name)) return { error: 'findElements (several elements) is not converted' };
  if ((fn.name === 'until' || fn.name === 'Until') && e.args[0]?.k === 'call') {
    const ec = e.args[0];
    const nm = ec.fn.k === 'member' ? ec.fn.name : ec.fn.k === 'ref' ? ec.fn.name : '';
    if (EC_ELEMENT.test(nm)) return byOf(ec.args, vars) ?? { error: 'unrecognised By locator in wait condition' };
  }
  return undefined;
}

// ------------------------------------------------------------------ observables and claims

type Obs =
  | { k: 'title' }
  | { k: 'url' }
  | { k: 'source' }
  | { k: 'text'; cand: LocatorCandidate }
  | { k: 'value'; cand: LocatorCandidate }
  | { k: 'displayed'; cand: LocatorCandidate }
  | { k: 'contains'; obs: Obs; needle: string }
  | { k: 'equals'; obs: Obs; value: string };

function observable(e: Expr, vars: Map<string, Expr>): Obs | undefined {
  const el = (x: Expr) => {
    const c = elementOf(x, vars);
    return c && !('error' in c) ? c : undefined;
  };
  if (e.k === 'member') {
    const n = e.name;
    const c = el(e.obj);
    if (c) {
      if (n === 'text' || n === 'Text') return { k: 'text', cand: c };
      if (n === 'Displayed') return { k: 'displayed', cand: c };
      return undefined;
    }
    if (n === 'title' || n === 'Title') return { k: 'title' };
    if (n === 'current_url' || n === 'Url') return { k: 'url' };
    if (n === 'page_source' || n === 'PageSource') return { k: 'source' };
    return undefined;
  }
  if (e.k === 'call' && e.fn.k === 'member') {
    const n = e.fn.name;
    const s0 = strOf(e.args[0], vars);
    if (/^(?:contains|Contains|__contains__)$/.test(n) && s0 !== undefined) {
      const o = observable(e.fn.obj, vars);
      return o ? { k: 'contains', obs: o, needle: s0 } : undefined;
    }
    if (/^(?:equals|Equals)$/.test(n) && s0 !== undefined) {
      const o = observable(e.fn.obj, vars);
      return o ? { k: 'equals', obs: o, value: s0 } : undefined;
    }
    const c = el(e.fn.obj);
    if (c) {
      if (/^(?:getText|GetText)$/.test(n)) return { k: 'text', cand: c };
      if (/^(?:isDisplayed|is_displayed)$/.test(n)) return { k: 'displayed', cand: c };
      if (/^(?:getAttribute|get_attribute|GetAttribute|getDomProperty|get_property|GetDomProperty)$/.test(n) && s0 === 'value') return { k: 'value', cand: c };
      return undefined;
    }
    if (/^(?:getTitle)$/.test(n)) return { k: 'title' };
    if (/^(?:getCurrentUrl)$/.test(n)) return { k: 'url' };
    if (/^(?:getPageSource)$/.test(n)) return { k: 'source' };
  }
  return undefined;
}

type Claim = { kind: 'equals' | 'contains' | 'notContains'; obs: Obs; value: string } | { kind: 'true' | 'false'; obs: Obs };

/** Turn `x == "v"` style pieces into a claim (either operand order). */
function equalsClaim(a: Expr, b: Expr, vars: Map<string, Expr>): Claim | undefined {
  const sa = strOf(a, vars);
  const sb = strOf(b, vars);
  const oa = observable(a, vars);
  const ob = observable(b, vars);
  if (oa && sb !== undefined) return { kind: 'equals', obs: oa, value: sb };
  if (ob && sa !== undefined) return { kind: 'equals', obs: ob, value: sa };
  return undefined;
}

function truthClaim(e: Expr, vars: Map<string, Expr>, negate = false): Claim | undefined {
  if (e.k === 'not') return truthClaim(e.e, vars, !negate);
  if (e.k === 'cmp') {
    if ((e.op === '==' || e.op === '===') && !negate) return equalsClaim(e.left, e.right, vars);
    if (e.op === 'in' || e.op === 'not in') {
      const needle = strOf(e.left, vars);
      const o = observable(e.right, vars);
      if (needle === undefined || !o) return undefined;
      const neg = (e.op === 'not in') !== negate;
      return { kind: neg ? 'notContains' : 'contains', obs: o, value: needle };
    }
    return undefined;
  }
  const o = observable(e, vars);
  if (!o) return undefined;
  if (o.k === 'contains') return { kind: negate ? 'notContains' : 'contains', obs: o.obs, value: o.needle };
  if (o.k === 'equals') return negate ? undefined : { kind: 'equals', obs: o.obs, value: o.value };
  return { kind: negate ? 'false' : 'true', obs: o };
}

/** Recognise assertion calls of JUnit/TestNG/AssertJ/NUnit/MSTest/xUnit/unittest. */
function assertionClaim(e: Expr, vars: Map<string, Expr>): Claim | 'unsupported' | undefined {
  if (e.k !== 'call') return undefined;
  const segs = flatten(e);
  // AssertJ: assertThat(obs).isEqualTo("x") / .contains("x") / .isTrue()
  if (segs[0]?.name === 'assertThat' && segs[0].call && segs.length === 2 && segs[1].call) {
    const o = observable(segs[0].args[0], vars);
    const v = strOf(segs[1].args[0], vars);
    if (!o) return 'unsupported';
    if (segs[1].name === 'isEqualTo' && v !== undefined) return { kind: 'equals', obs: o, value: v };
    if (segs[1].name === 'contains' && v !== undefined) return { kind: 'contains', obs: o, value: v };
    if (segs[1].name === 'isTrue') return truthClaim(segs[0].args[0], vars) ?? 'unsupported';
    if (segs[1].name === 'isFalse') return truthClaim(segs[0].args[0], vars, true) ?? 'unsupported';
    return 'unsupported';
  }
  const last = segs[segs.length - 1];
  if (!last?.call || !last.name) return undefined;
  const fq = segs.map((s) => s.name ?? '').join('.');
  const n = last.name;
  const args = last.args;
  if (!/^(?:assert|Assert|StringAssert|self\.assert|Assertions\.|Assert\.)/.test(fq) && !/^assert/i.test(n)) return undefined;
  if (/^(?:assertEquals|AreEqual|Equal|assertEqual)$/.test(n) && args.length >= 2) return equalsClaim(args[0], args[1], vars) ?? 'unsupported';
  if (/^(?:assertTrue|IsTrue|True|assert_)$/.test(n) && args.length >= 1) return truthClaim(args[0], vars) ?? 'unsupported';
  if (/^(?:assertFalse|IsFalse|False)$/.test(n) && args.length >= 1) return truthClaim(args[0], vars, true) ?? 'unsupported';
  if (/^(?:assertIn|Contains)$/.test(n) && args.length >= 2) {
    // assertIn(needle, haystack) / StringAssert.Contains(expected, actual) / xUnit Assert.Contains(expected, actual)
    const needle = strOf(args[0], vars);
    const o = observable(args[1], vars);
    return needle !== undefined && o ? { kind: 'contains', obs: o, value: needle } : 'unsupported';
  }
  if (/^(?:assertNotIn|DoesNotContain)$/.test(n) && args.length >= 2) {
    const needle = strOf(args[0], vars);
    const o = observable(args[1], vars);
    return needle !== undefined && o ? { kind: 'notContains', obs: o, value: needle } : 'unsupported';
  }
  if (n === 'That' && args.length >= 2) {
    // NUnit constraint model: Assert.That(actual, Is.EqualTo("x") | Does.Contain("x") | Is.True)
    const o = observable(args[0], vars);
    const c = flatten(args[1]).map((s) => s.name ?? '').join('.');
    const cs = flatten(args[1]);
    const v = strOf(cs[cs.length - 1]?.args[0], vars);
    if (!o) return 'unsupported';
    if (/^Is\.EqualTo$/.test(c) && v !== undefined) return { kind: 'equals', obs: o, value: v };
    if (/^(?:Does\.Contain|Contains\.Substring)$/.test(c) && v !== undefined) return { kind: 'contains', obs: o, value: v };
    if (c === 'Is.True') return truthClaim(args[0], vars) ?? 'unsupported';
    if (c === 'Is.False') return truthClaim(args[0], vars, true) ?? 'unsupported';
    return 'unsupported';
  }
  return 'unsupported';
}

function claimPhrase(c: Claim): { phrase: string; type: string; cand?: LocatorCandidate; note?: string } | { error: string } {
  const o = c.obs;
  const desc = (cand: LocatorCandidate, hint: TargetHint = 'generic') => describeLocator(cand, hint);
  if (c.kind === 'true' || c.kind === 'false') {
    if (o.k !== 'displayed') return { error: 'boolean assertion on something other than visibility' };
    const d = desc(o.cand);
    if (!d) return { error: 'locator cannot be expressed in .ez' };
    return c.kind === 'true'
      ? { phrase: `${d} is visible`, type: 'visible', cand: expectedCandidate(o.cand, d) }
      : { phrase: `${d} is hidden`, type: 'hidden', cand: expectedCandidate(o.cand, d) };
  }
  if (!('value' in c)) return { error: 'assertion form is not converted' };
  const v = q(c.value);
  if (c.kind === 'notContains') {
    if (o.k === 'source') return { phrase: `the page does not contain ${v}`, type: 'pageNotContainsText' };
    return { error: 'negative assertion is not converted' };
  }
  switch (o.k) {
    case 'title':
      return { phrase: `the title contains ${v}`, type: 'titleContains', ...(c.kind === 'equals' ? { note: 'title equality converted to "title contains"' } : {}) };
    case 'url':
      return c.kind === 'equals' ? { phrase: `the URL is ${v}`, type: 'urlMatches' } : { phrase: `the URL contains ${v}`, type: 'urlContains' };
    case 'source':
      return c.kind === 'contains' ? { phrase: `the page contains ${v}`, type: 'pageContainsText' } : { error: 'page source equality is not converted' };
    case 'text': {
      const d = desc(o.cand);
      if (!d) return { error: 'locator cannot be expressed in .ez' };
      return c.kind === 'equals'
        ? { phrase: `${d} has text ${v}`, type: 'textEquals', cand: expectedCandidate(o.cand, d) }
        : { phrase: `${d} contains ${v}`, type: 'textContains', cand: expectedCandidate(o.cand, d) };
    }
    case 'value': {
      const d = desc(o.cand, 'field');
      if (!d || c.kind !== 'equals') return { error: 'value assertion is not converted' };
      return { phrase: `${d} has value ${v}`, type: 'valueEquals', cand: expectedCandidate(o.cand, d) };
    }
    default:
      return { error: 'assertion form is not converted' };
  }
}

// ------------------------------------------------------------------ statements

const INFRA = /\b(?:new\s+(?:Chrome|Firefox|Edge|Safari|InternetExplorer|Remote)(?:Driver|WebDriver)\b|webdriver\.(?:Chrome|Firefox|Edge|Safari|Remote)\b|(?:quit|Quit|close|Close|Dispose)\s*\(\s*\)|\.manage\(\)|\.Manage\(\)|implicitly_wait|maximize_window|set_window_size|set_page_load_timeout|WebDriverManager|(?:Chrome|Firefox|Edge)Options|add_argument|addArguments|AddArgument|System\.out|System\.err|Console\.Write|^print\s*\(|\blogger\.|\bLOG\.|\blog\.|super\.setUp|super\(\)\.setUp|new\s+WebDriverWait|WebDriverWait\s*\(\s*(?:self\.)?driver\s*,\s*[\d.]+\s*\)\s*$|^(?:self\.)?wait\s*=)/;

const KEY_NAMES: Record<string, string> = {
  ENTER: 'Enter', RETURN: 'Enter', TAB: 'Tab', ESCAPE: 'Escape', BACK_SPACE: 'Backspace', BACKSPACE: 'Backspace',
  DELETE: 'Delete', SPACE: 'Space', ARROW_DOWN: 'ArrowDown', ARROW_UP: 'ArrowUp', ARROW_LEFT: 'ArrowLeft', ARROW_RIGHT: 'ArrowRight',
  DOWN: 'ArrowDown', UP: 'ArrowUp', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight', HOME: 'Home', END: 'End', PAGE_DOWN: 'PageDown', PAGE_UP: 'PageUp',
  Enter: 'Enter', Return: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', Space: 'Space',
  ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End',
};

/** Split sendKeys arguments into text and key presses. */
function keyParts(args: Expr[], vars: Map<string, Expr>): Array<{ text?: string; key?: string }> | undefined {
  const out: Array<{ text?: string; key?: string }> = [];
  const add = (e: Expr): boolean => {
    if (e.k === 'concat') return e.parts.every(add);
    const s = strOf(e, vars);
    if (s !== undefined) {
      const m = /^([\s\S]*?)(\n|\r\n?)?$/.exec(s)!;
      if (m[1]) out.push({ text: m[1] });
      if (m[2]) out.push({ key: 'Enter' });
      return true;
    }
    const d = dotted(e);
    const km = d && /^Keys\.(\w+)$/.exec(d);
    if (km && KEY_NAMES[km[1]]) {
      out.push({ key: KEY_NAMES[km[1]] });
      return true;
    }
    return false;
  };
  for (const a of args) if (!add(a)) return undefined;
  return out;
}

function hintOf(method: string): TargetHint {
  if (/^(?:sendKeys|send_keys|SendKeys|clear|Clear)$/.test(method)) return 'field';
  if (/^(?:click|Click)$/.test(method)) return 'click';
  return 'generic';
}

/** Seconds/ms wait literal. */
function sleepStep(e: Expr): string | undefined {
  const d = e.k === 'call' ? dotted(e.fn) : undefined;
  if (!d || e.k !== 'call' || e.args[0]?.k !== 'num') return undefined;
  const n = e.args[0].v;
  if (d === 'Thread.sleep' || d === 'Thread.Sleep') return `Wait ${Math.round(n)} ms`;
  if (d === 'time.sleep') return `Wait ${Math.round(n * 1000)} ms`;
  return undefined;
}

function statement(d: JourneyDraft, ctx: Ctx, s: Stmt): void {
  try {
    statementInner(d, ctx, s);
  } catch (e) {
    d.addTodo({ line: ctx.toks[s.start].line, original: textOf(ctx.src, ctx.toks, s) }, `conversion error: ${(e as Error).message}`);
  }
}

function statementInner(d: JourneyDraft, ctx: Ctx, s: Stmt): void {
  const { toks, vars } = ctx;
  const original = textOf(ctx.src, toks, s);
  const src: SourceRef = { line: toks[s.start].line, original };
  const first = toks[s.start];
  if (first.t === 'p' && first.v === '{') {
    for (const inner of splitStatements(toks, s.start + 1, s.end - 1, ctx.lang)) statement(d, ctx, inner);
    return;
  }
  if (first.t === 'id' && /^(?:if|for|foreach|while|do|switch|try|with|return|throw|using|lock)$/.test(first.v)) {
    d.addTodo(src, `control flow ("${first.v}") is not converted`);
    return;
  }
  if (INFRA.test(oneLine(original))) {
    ctx.warnings.push(`${ctx.file}:${src.line}: ignored test-infrastructure statement: ${oneLine(original)}`);
    return;
  }
  if (first.t === 'id' && (first.v === 'pass' || first.v === 'super')) return;
  // python assert statement
  if (ctx.lang === 'py' && first.v === 'assert') {
    let end = s.end;
    let depth = 0;
    for (let k = s.start + 1; k < s.end; k++) {
      const v = toks[k].v;
      if (toks[k].t === 'p' && (v === '(' || v === '[' || v === '{')) depth++;
      else if (toks[k].t === 'p' && (v === ')' || v === ']' || v === '}')) depth--;
      else if (v === ',' && depth === 0) {
        end = k;
        break;
      }
    }
    try {
      const e = substitute(parseExpr(toks, s.start + 1, end), vars);
      const c = truthClaim(e, vars);
      if (!c) return void d.addTodo(src, 'assertion form is not converted', 'assertion');
      return claim(d, ctx, c, src);
    } catch (err) {
      return void d.addTodo(src, `cannot parse assertion: ${(err as Error).message}`, 'assertion');
    }
  }
  // C#: driver.Url = "..."
  const eq = (() => {
    for (let k = s.start; k < s.end; k++) if (toks[k].t === 'p' && toks[k].v === '=') return k;
    return -1;
  })();
  if (eq > 0 && toks[eq - 1]?.v === 'Url' && toks[eq - 2]?.v === '.') {
    try {
      const v = strOf(parseExpr(toks, eq + 1, s.end), vars);
      if (v !== undefined) return void d.step(`Open ${q(v)}`, src, { action: 'navigate', value: v });
    } catch {
      // fall through
    }
    return void d.addTodo(src, 'URL is not a literal');
  }
  const decl = declaration(toks, s);
  let e: Expr;
  try {
    e = parseExpr(toks, decl ? decl.valueStart : s.start, s.end);
  } catch (err) {
    return void d.addTodo(src, `cannot parse statement: ${(err as ParseError).message}`);
  }
  e = substitute(e, vars);
  if (decl) {
    const el = elementOf(e, vars);
    const isSelect = e.k === 'call' && /^(?:Select|SelectElement)$/.test(dotted(e.fn) ?? '');
    if (dotted(e) !== undefined) return; // alias such as `driver = self.driver`
    if (strOf(e, vars) !== undefined || (el && !('error' in el) && !isUntil(e)) || isSelect) {
      vars.set(decl.name, e);
      return;
    }
    const o = observable(e, vars);
    if (o && (o.k === 'text' || o.k === 'value')) {
      const desc = describeLocator(o.cand);
      if (!desc) return void d.addTodo(src, 'locator cannot be expressed in .ez');
      d.step(`Capture the ${o.k} of ${desc} as ${decl.name}`, src, { action: 'capture', candidate: expectedCandidate(o.cand, desc) });
      vars.set(decl.name, { k: 'str', v: `\${${decl.name}}` });
      return;
    }
  }
  convert(d, ctx, e, src);
}

function isUntil(e: Expr): boolean {
  return e.k === 'call' && e.fn.k === 'member' && (e.fn.name === 'until' || e.fn.name === 'Until');
}

function claim(d: JourneyDraft, ctx: Ctx, c: Claim, src: SourceRef): void {
  const p = claimPhrase(c);
  if ('error' in p) return void d.addTodo(src, p.error, 'assertion');
  if (p.note) ctx.warnings.push(`${ctx.file}:${src.line}: ${p.note}`);
  d.expect(p.phrase, src, { type: p.type as never, ...(p.cand ? { candidate: p.cand } : {}) });
}

function convert(d: JourneyDraft, ctx: Ctx, e: Expr, src: SourceRef): void {
  const { vars } = ctx;
  const sl = sleepStep(e);
  if (sl) return void d.step(sl, src, { action: 'wait' });
  const ac = assertionClaim(e, vars);
  if (ac === 'unsupported') return void d.addTodo(src, 'assertion form is not converted', 'assertion');
  if (ac) return claim(d, ctx, ac, src);
  if (e.k !== 'call' || e.fn.k !== 'member') return void d.addTodo(src, 'statement is not a WebDriver call');
  const method = e.fn.name;
  const recv = e.fn.obj;
  const s0 = strOf(e.args[0], vars);

  // navigation
  if ((method === 'get' || method === 'GoToUrl' || method === 'to') && e.args.length === 1 && !elementOf(recv, vars)) {
    if (s0 === undefined) return void d.addTodo(src, 'URL is not a literal');
    return void d.step(`Open ${q(s0)}`, src, { action: 'navigate', value: s0 });
  }
  if (/^(?:back|Back)$/.test(method) && !e.args.length) return void d.step('Go back', src, { action: 'navigate' });
  if (/^(?:forward|Forward)$/.test(method) && !e.args.length) return void d.step('Go forward', src, { action: 'navigate' });
  if (/^(?:refresh|Refresh)$/.test(method) && !e.args.length) return void d.step('Reload the page', src, { action: 'navigate' });

  // Select helpers
  if (recv.k === 'call' && /^(?:Select|SelectElement)$/.test(dotted(recv.fn) ?? '')) {
    const el = recv.args[0] ? elementOf(recv.args[0], vars) : undefined;
    if (!el) return void d.addTodo(src, 'Select() over an unrecognised element');
    if ('error' in el) return void d.addTodo(src, el.error);
    if (/^(?:selectByVisibleText|select_by_visible_text|SelectByText|selectByValue|select_by_value|SelectByValue)$/.test(method)) {
      if (s0 === undefined) return void d.addTodo(src, 'option is not a literal string');
      const desc = describeLocator(el, 'dropdown');
      if (!desc) return void d.addTodo(src, 'locator cannot be expressed in .ez');
      return void d.step(`Select ${q(s0)} from ${desc}`, src, { action: 'select', value: s0, candidate: expectedCandidate(el, desc) });
    }
    return void d.addTodo(src, `Select.${method} is not converted`);
  }

  // explicit waits: wait.until(EC.visibilityOfElementLocated(By...)) / until(EC.urlContains("x"))
  if (method === 'until' || method === 'Until') {
    const ec = e.args[0];
    if (ec?.k === 'call') {
      const nm = ec.fn.k === 'member' ? ec.fn.name : ec.fn.k === 'ref' ? ec.fn.name : '';
      const v = strOf(ec.args[0], vars);
      if (EC_ELEMENT.test(nm)) {
        const el = byOf(ec.args, vars);
        if (!el || 'error' in el) return void d.addTodo(src, el && 'error' in el ? el.error : 'unrecognised wait locator');
        const desc = describeLocator(el);
        if (!desc) return void d.addTodo(src, 'locator cannot be expressed in .ez');
        return void d.step(`Wait for ${desc}`, src, { action: 'wait', candidate: expectedCandidate(el, desc) });
      }
      if (/^(?:invisibilityOfElementLocated|invisibility_of_element_located|InvisibilityOfElementLocated)$/.test(nm)) {
        const el = byOf(ec.args, vars);
        if (!el || 'error' in el) return void d.addTodo(src, 'unrecognised wait locator');
        const desc = describeLocator(el);
        if (!desc) return void d.addTodo(src, 'locator cannot be expressed in .ez');
        return void d.step(`Wait for ${desc} to disappear`, src, { action: 'wait' });
      }
      if (/^(?:urlContains|url_contains|UrlContains)$/.test(nm) && v !== undefined) return void d.expect(`the URL contains ${q(v)}`, src, { type: 'urlContains' });
      if (/^(?:titleContains|title_contains|TitleContains|titleIs|title_is|TitleIs)$/.test(nm) && v !== undefined) return void d.expect(`the title contains ${q(v)}`, src, { type: 'titleContains' });
    }
    return void d.addTodo(src, 'wait condition is not converted');
  }

  // element actions
  const el = elementOf(recv, vars);
  if (el && 'error' in el) return void d.addTodo(src, el.error);
  if (el) {
    const desc = describeLocator(el, hintOf(method));
    if (!desc) return void d.addTodo(src, `locator ${el.strategy}=${JSON.stringify(el.value)} cannot be expressed in .ez`);
    const candidate = expectedCandidate(el, desc);
    if (/^(?:click|Click)$/.test(method)) return void d.step(`Click ${desc}`, src, { action: 'click', candidate });
    if (/^(?:clear|Clear)$/.test(method)) return void d.step(`Clear ${desc}`, src, { action: 'clear', candidate });
    if (/^(?:sendKeys|send_keys|SendKeys)$/.test(method)) {
      const parts = keyParts(e.args, vars);
      if (!parts || !parts.length) return void d.addTodo(src, 'sendKeys arguments are not literals');
      const text = parts.filter((p) => p.text !== undefined).map((p) => p.text).join('');
      const keys = parts.filter((p) => p.key);
      const keysAfterText = parts.findIndex((p) => p.key) === -1 || parts.slice(parts.findIndex((p) => p.key)).every((p) => p.key);
      if (!keysAfterText) return void d.addTodo(src, 'text typed after a special key is not converted');
      if (text) d.step(`Type ${q(text)} into ${desc}`, src, { action: 'fill', value: text, candidate });
      for (const k of keys) d.step(`Press ${k.key} in ${desc}`, src, { action: 'press', value: k.key, candidate });
      return;
    }
    return void d.addTodo(src, `element method .${method}() is not converted`);
  }
  d.addTodo(src, `${dotted(e.fn) ?? method}(...) is not converted`);
}

/** Import Selenium test source (Java, C# or Python). */
export function importSelenium(src: string, opts: SeleniumOptions = {}): ImportReport {
  const lang = opts.language ?? detectSeleniumLanguage(src, opts.file);
  const file = opts.file ?? `selenium.${lang}`;
  const ids = opts.ids ?? new Set<string>();
  const warnings: string[] = [];
  let toks: Token[];
  try {
    toks = tokenize(src, lang);
  } catch (e) {
    return assembleReport([], [file], [], [{ file, line: 1, original: oneLine(src.slice(0, 120)), reason: `cannot read source: ${(e as LexError).message}` }]);
  }
  const methods = lang === 'py' ? pythonMethods(toks) : braceMethods(toks, lang);
  const ctx: Ctx = { src, toks, lang, file, vars: new Map(), warnings };
  // file-level string constants (Java/C# fields, Python module constants)
  for (const st of splitStatements(toks, 0, toks.length, lang)) {
    const decl = declaration(toks, st);
    if (!decl) continue;
    try {
      const v = parseExpr(toks, decl.valueStart, st.end);
      if (v.k === 'str' && !v.template) ctx.vars.set(decl.name, v);
    } catch {
      // not a constant
    }
  }
  for (let k = 0; k + 4 < toks.length; k++) {
    const t = toks;
    if (lang !== 'py' && t[k].t === 'id' && /^(?:String|string|var|const)$/.test(t[k].v) && t[k + 1].t === 'id' && t[k + 2].v === '=' && t[k + 3].t === 'str' && !t[k + 3].template && t[k + 4].v === ';') {
      ctx.vars.set(t[k + 1].v, { k: 'str', v: t[k + 3].v });
    }
  }
  const drafts: JourneyDraft[] = [];
  for (const m of methods.filter((x) => x.kind === 'teardown')) warnings.push(`${file}:${m.line}: teardown/class-level method ${m.name} not imported`);
  const setups = methods.filter((x) => x.kind === 'setup');
  for (const m of methods.filter((x) => x.kind === 'test')) {
    const d = new JourneyDraft(humanize(m.name), { kind: 'selenium', file, line: m.line, ids, tags: [...(opts.tags ?? []), ...m.tags] });
    const vars = new Map(ctx.vars);
    const c: Ctx = { ...ctx, vars };
    for (const su of setups.filter((x) => lang !== 'py' || x.col === m.col)) {
      d.comment(`setup: ${su.name}`);
      for (const st of splitStatements(toks, su.body.start, su.body.end, lang)) statement(d, c, st);
    }
    if (setups.length) d.comment(`test: ${m.name}`);
    for (const st of splitStatements(toks, m.body.start, m.body.end, lang)) statement(d, c, st);
    drafts.push(d);
  }
  if (!drafts.length) warnings.push(`${file}: no Selenium tests found`);
  return assembleReport(drafts, [file], [...new Set(warnings)]);
}
