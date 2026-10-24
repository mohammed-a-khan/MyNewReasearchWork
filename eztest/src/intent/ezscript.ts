/**
 * The `.ez` script format: a readable journey file.
 *
 *   Journey: Bob creates an order
 *   Tags: @smoke @orders
 *   Open /login
 *   Type "bob" into the Username field
 *   Click the "Sign in" button
 *     Expect the URL contains "/dashboard"     <- post-condition of the click
 *
 * Expect/Verify lines that follow a step become post-conditions of that step;
 * an Expect line with no step before it becomes a standalone assert step.
 *
 * Blocks (If/Otherwise, Repeat, For each, While, Retry, Try/On failure,
 * Group, "In the X frame") run until a matching "End". Indentation is free.
 * An "Examples:" table makes the journey data-driven (one run per row);
 * "Examples: from data "rows.json" where runFlag = Yes" takes the rows from a
 * data file (or "from query NAME on <connection>") at run time.
 */
import { BLOCK_ACTIONS, Journey, Step, slugify, type DataNeed, type Emulation, type JourneyInput, type StepInput } from '../core/index.js';
import { conditionToText, parseCondition } from './conditions.js';
import { IntentParseError, defaultStepId, parseIntent, matchesPluginRule } from './parse.js';
import { protectQuotes, literal, quoteText } from './quotes.js';
import { advancedStepToText, advancedWaitToText } from './render-advanced.js';
import { isStepExpectation } from './rules-migration.js';
import { examplesSourceToText, isExamplesFromLine, parseExamplesSource } from './examples-source.js';
import { isNamedQueryExpectation, queryStepToText } from './rules-queries.js';
import { isDesktopExpectation } from './rules-desktop.js';
import { isIntegrationExpectation } from '../integration/rules.js';
import { isStoreExpectation } from '../store/rules.js';
import { isDocumentLookExpectation } from './rules.js';
import { isSpecialistExpectation } from './rules-specialist.js';
import { dependsOnToText, parseDependsOn, parseRequires, requiresToText } from './requires.js';
import { mobileStepToText } from './rules-mobile.js';
import { isVisualExpectation } from './rules-visual.js';
import { isA11yExpectation } from './rules-a11y.js';
import { isComponentExpectation } from './rules-components.js';
import { ATTACHMENT_LINE, EXPECTED_LINE } from './rules-manual.js';
import { isKeyboardExpectation } from './rules-keyboard.js';

export interface ParseEzOptions {
  /** Journey id; defaults to the `Id:` header, else a slug of the journey name. */
  id?: string;
  /** File name used in error messages. */
  source?: string;
}

const HEADER = /^(journey|setup|teardown|name|id|tags|role|requirements?|risk|locks?|base\s*url|variables|vars|description|lenses|data|params|parameters|returns|device|viewport|locale|time\s*zone|colou?r\s*scheme|reduced\s*motion|geolocation|permissions|user\s*agent|touch|offline|http\s*credentials|extra\s*headers|headers|loaders|platform|story|app|electron|requires|depends\s*on|capabilities|actors|browsers|clock|type|assignee|assigned\s*to|preconditions?)\s*:\s*(.*)$/i;
const EXPECT = /^(?:(?:then|and|also)\s+)?(?:expect|verify)\s+(?:that\s+)?(.+)$/i;
const SOFT = /^(?:(?:then|and|also)\s+)?(?:(?:expect|verify)\s+softly|soft(?:ly)?\s+(?:expect|verify))\b/i;
const END = /^(?:end(?:\s+(?:if|unless|repeat|for(?:\s+each)?|each|loop|while|retry|try|group|frame|in\s+frame|block|journey))?|done|next|endif)\s*[.;]?$/i;
const ELSE = /^(?:otherwise|else)\s*:?$/i;
const ELSE_IF = /^(?:otherwise|else)\s+(if|unless)\s+(.+)$/i;
const CATCH = /^(?:on\s+(?:failure|error)|if\s+(?:it|that|this)\s+fails|catch|otherwise|else|when\s+it\s+fails)\s*:?$/i;
const EXAMPLES = /^(?:examples|scenarios|data\s+table)\s*:\s*$/i;

function splitList(s: string): string[] {
  return s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
}

/** Parse `a=b, c="d e"` into a record (comma separated; values may be quoted). */
/** Parse `serial="emulator-5554", locale="fr-FR", clearData=true`: unquoted true/false/numbers are typed, quoted values stay text. */
function parseCaps(s: string, where: string): Record<string, string | number | boolean> {
  const { text, quotes } = protectQuotes(s);
  const out: Record<string, string | number | boolean> = {};
  for (const part of text.split(',')) {
    if (!part.trim()) continue;
    const m = /^\s*([A-Za-z_][\w.:-]*)\s*=\s*(.*?)\s*$/.exec(part);
    if (!m) throw new Error(`${where}: expected name=value in Capabilities, got "${part.trim()}"`);
    const raw = m[2];
    out[m[1]] = /^(?:true|false)$/i.test(raw) ? raw.toLowerCase() === 'true' : /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : literal(raw, quotes);
  }
  return out;
}

function parseVars(s: string, where: string, colonKeys = false, header = 'Variables'): Record<string, string> {
  const { text, quotes } = protectQuotes(s);
  const out: Record<string, string> = {};
  // Data constraints read like the other filters ("where region=EU and segment=RETAIL"); quoted values are protected.
  for (const part of text.split(header === 'Data' ? /\s*,\s*|\s+and\s+/i : ',')) {
    if (!part.trim()) continue;
    const m = (colonKeys ? /^\s*([A-Za-z_][\w.:-]*)\s*=\s*(.*)$/ : /^\s*([A-Za-z_][\w.-]*)\s*=\s*(.*)$/).exec(part);
    if (!m) throw new Error(`${where}: expected name=value in ${header}, got "${part.trim()}"`);
    out[m[1]] = literal(m[2], quotes);
  }
  return out;
}

/** Parse `Customer as customer where region=EU; Product as item` into data needs. */
function parseData(s: string, where: string): DataNeed[] {
  return s.split(';').filter((p) => p.trim()).map((part) => {
    const m = /^\s*(\w+)\s+as\s+(\w+)(?:\s+where\s+(.+))?\s*$/i.exec(part);
    if (!m) throw new Error(`${where}: expected "<Entity> as <alias> [where k=v, ...]" in Data, got "${part.trim()}"`);
    return { entity: m[1], as: m[2], where: m[3] ? parseVars(m[3], where, false, 'Data') : {}, strategy: 'find-or-create' as const };
  });
}

/** One table row "| a | "b c" |" into cells. */
function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|\s*$/, '');
  return inner.split('|').map((c) => {
    const t = c.trim();
    const { text, quotes } = protectQuotes(t);
    return literal(text, quotes);
  });
}

interface Frame {
  step: StepInput;
  branch: 'steps' | 'else' | 'catch';
  lineNumber: number;
  /** Opened by "Otherwise if": closed by the same End as its parent. */
  chained?: boolean;
  /**
   * An "As <actor>:" section: closed by End, by the next As / Switch to user line of the same list,
   * or by the end of the file. An End indented less than the As line closes the section and the
   * block around it ("In parallel:" ... "End").
   */
  section?: boolean;
  /** Indentation of the opening line. */
  indent?: number;
  /** Indentation of the section's first line (deeper than `indent` when the section is indented). */
  contentIndent?: number;
}

/** Parse an .ez script into a validated Journey. Errors carry line numbers. */
/**
 * Examples placeholders (`<column>`) are filled in after a line is parsed, so they work where the
 * grammar takes text but not where it needs a number (a status code, a row count, a duration).
 * A line that fails with one gets a hint with the ${column} form, which works everywhere.
 */
function placeholderHint(line: string, message: string): string {
  const m = /<([A-Za-z_][\w -]*)>/.exec(line);
  if (!m || /placeholder/i.test(message)) return '';
  return ` (Examples placeholders like <${m[1]}> are filled in after the line is read, so they cannot stand where a number is expected; every row value is also a variable, so write the check as an expression, e.g. "Expect \${response.status} == \${${m[1]}}")`;
}

export function parseEzScript(text: string, opts: ParseEzOptions = {}): Journey {
  const src = opts.source ? `${opts.source}:` : '';
  const j: JourneyInput & { steps: StepInput[] } = { id: '', name: '', steps: [] };
  const ids = new Map<string, number>();
  const stack: Frame[] = [];
  const lines = text.split(/\r?\n/);
  const listOf = (): StepInput[] => {
    const top = stack[stack.length - 1];
    if (!top) return j.steps;
    const s = top.step;
    if (top.branch === 'else') return (s.else ??= []);
    if (top.branch === 'catch') return (s.catch ??= []);
    return (s.steps ??= []);
  };
  /** Give a step (and any inline children) journey-unique ids, in document order. */
  const register = (s: StepInput) => {
    const n = (ids.get(s.id) ?? 0) + 1;
    ids.set(s.id, n);
    if (n > 1) s.id = `${s.id}-${n}`;
    for (const c of [...(s.steps ?? []), ...(s.else ?? []), ...(s.catch ?? [])]) register(c);
  };
  const fail = (where: string, line: string, lineNumber: number, message: string, suggestions: string[] = []): never => {
    throw new IntentParseError(`${where}: ${message}${placeholderHint(line, message)}`, line, lineNumber, suggestions);
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const where = `${src}line ${lineNumber}`;
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    // External Examples: "Examples: from data "file.json" [sheet "S"] [path "$.x"] [where <filter>]".
    if (isExamplesFromLine(line)) {
      if (stack.length) fail(where, line, lineNumber, 'Examples: must be outside blocks');
      if (j.examples || j.examplesFrom) fail(where, line, lineNumber, 'a journey has only one Examples section');
      try {
        j.examplesFrom = parseExamplesSource(line);
      } catch (err) {
        fail(where, line, lineNumber, (err as Error).message);
      }
      continue;
    }

    // Examples table (data-driven journey): "Examples:" then "| col | col |" rows.
    if (EXAMPLES.test(line)) {
      if (j.examplesFrom) fail(where, line, lineNumber, 'a journey has only one Examples section');
      if (stack.length) fail(where, line, lineNumber, 'Examples: must be outside blocks');
      const rows: string[][] = [];
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(tableCells(lines[++i]));
      if (rows.length < 2) fail(where, line, lineNumber, 'Examples: needs a header row and at least one data row ("| user | password |")');
      const [head, ...body] = rows;
      head.forEach((h, k) => {
        const first = head.indexOf(h);
        if (first !== k) fail(where, line, lineNumber, `Examples: the column "${h}" appears twice in the header (columns ${first + 1} and ${k + 1}); give every column its own name`);
      });
      j.examples = body.map((r, n) => {
        if (r.length !== head.length) fail(`${src}line ${lineNumber + n + 2}`, line, lineNumber + n + 2, `row has ${r.length} cells, header has ${head.length}`);
        return Object.fromEntries(head.map((h, k) => [h, r[k]]));
      });
      continue;
    }

    const h = j.steps.length === 0 && stack.length === 0 ? HEADER.exec(line) : null;
    if (h) {
      applyHeader(j, h[1].toLowerCase().replace(/\s+/g, ' '), h[2].trim(), where);
      continue;
    }

    // ---------------------------------------------------------------- block structure
    // An indented As section ends at the first line that is not indented deeper than its As line.
    if (!END.test(line)) {
      const indent = lines[i].length - lines[i].trimStart().length;
      for (let top = stack[stack.length - 1]; top?.section; top = stack[stack.length - 1]) {
        top.contentIndent ??= indent;
        if (top.contentIndent > (top.indent ?? 0) && indent <= (top.indent ?? 0)) checkBlock(stack.pop()!, src, fail);
        else break;
      }
    }
    if (END.test(line)) {
      let top = stack.pop();
      if (!top) fail(where, line, lineNumber, `"${line}" has no open block to end`);
      // An End indented less than the As line it would close ends that As section and the enclosing block.
      const indent = lines[i].length - lines[i].trimStart().length;
      if (top!.section && stack.length && indent < (top!.indent ?? 0)) {
        checkBlock(top!, src, fail);
        top = stack.pop();
      }
      checkBlock(top!, src, fail);
      if (top!.chained) checkBlock(stack.pop()!, src, fail);
      continue;
    }
    const top = stack[stack.length - 1];
    if (top && top.step.action === 'try' && top.branch === 'steps' && CATCH.test(line)) {
      top.branch = 'catch';
      top.step.catch ??= [];
      continue;
    }
    if (top && (top.step.action === 'if') && top.branch === 'steps') {
      if (ELSE.test(line)) {
        top.branch = 'else';
        top.step.else ??= [];
        continue;
      }
      const ei = ELSE_IF.exec(line);
      if (ei) {
        let nested: StepInput;
        try {
          nested = parseIntent(`${ei[1]} ${ei[2].replace(/(?:\s+then|\s*:)\s*$/i, '')} then`, { lineNumber });
        } catch (err) {
          return fail(where, line, lineNumber, (err as Error).message.replace(/^line \d+: /, ''));
        }
        register(nested);
        top.branch = 'else';
        top.step.else = [nested];
        stack.push({ step: nested, branch: 'steps', lineNumber, chained: true });
        continue;
      }
    }

    // ---------------------------------------------------------------- manual step details
    let list = listOf();
    const before = list[list.length - 1];
    if (before?.action === 'manual') {
      const ex = EXPECTED_LINE.exec(line);
      const at = ex ? null : ATTACHMENT_LINE.exec(line);
      if (ex || at) {
        const args = (before.args ??= {}) as { expected?: string[]; attachments?: string[] };
        if (ex) (args.expected ??= []).push(ex[1].trim());
        else (args.attachments ??= []).push(at![1].trim().replace(/^"(.*)"$/, '$1'));
        continue;
      }
    }

    // ---------------------------------------------------------------- expectations
    const e = SOFT.test(line) ? null : EXPECT.exec(line);
    const prev = list[list.length - 1];
    // Add-on phrasings such as "Expect D365 field ..." are steps of their own, not post-conditions.
    if (e && prev && !matchesPluginRule(line) && !isStepExpectation(line) && !isNamedQueryExpectation(line) && !isVisualExpectation(line) && !isA11yExpectation(line) && !isComponentExpectation(line) && !isDesktopExpectation(line) && !isIntegrationExpectation(line) && !isSpecialistExpectation(line) && !isKeyboardExpectation(line) && !isStoreExpectation(line) && !isDocumentLookExpectation(line)) {
      try {
        (prev.postconditions ??= []).push(parseCondition(e[1].replace(/[.;]+$/, '')));
      } catch (err) {
        throw new IntentParseError(`${where}: ${(err as Error).message}${placeholderHint(line, (err as Error).message)}`, line, lineNumber, []);
      }
      continue;
    }

    // ---------------------------------------------------------------- steps
    let step: StepInput;
    try {
      step = parseIntent(line, { lineNumber });
    } catch (err) {
      if (err instanceof IntentParseError) {
        throw new IntentParseError(err.message.replace(/^line \d+: /, `${where}: `) + placeholderHint(line, err.message), line, lineNumber, err.suggestions);
      }
      throw err;
    }
    register(step);
    // The next "As <actor>" (or "Switch to user") line ends the current As section: the actors are siblings.
    if (step.action === 'actor' && stack[stack.length - 1]?.section) {
      checkBlock(stack.pop()!, src, fail);
      list = listOf();
    }
    list.push(step);
    // A block opener without an inline step collects the following lines up to "End".
    if (BLOCK_ACTIONS.has(step.action) && Array.isArray(step.steps) && step.steps.length === 0) {
      stack.push({ step, branch: 'steps', lineNumber, ...(step.action === 'actor' ? { section: true, indent: lines[i].length - lines[i].trimStart().length } : {}) });
    }
  }
  // As sections still open at the end of the file end there.
  while (stack.length && stack[stack.length - 1].section) checkBlock(stack.pop()!, src, fail);
  if (stack.length) {
    const open = stack[stack.length - 1];
    throw new IntentParseError(`${src}line ${open.lineNumber}: "${open.step.intent}" has no matching "End"`, open.step.intent, open.lineNumber, ['End']);
  }
  if (!j.name) throw new IntentParseError(`${src}missing "Journey: <name>" header`, '', undefined, ['Journey: My journey']);
  if (j.steps.length === 0) throw new IntentParseError(`${src}journey "${j.name}" has no steps`, '', undefined, []);
  j.id = opts.id ?? (j.id || slugify(j.name));
  checkJourneyType(j, src);
  return Journey.parse(j);
}

/** A `Type: manual` case holds only manual steps; `Type: automated` none. */
function checkJourneyType(j: JourneyInput & { steps: StepInput[] }, src: string): void {
  if (!j.type) return;
  const leaves: StepInput[] = [];
  const walk = (list: StepInput[] | undefined) => {
    for (const s of list ?? []) {
      if (s.steps || s.else || s.catch) {
        if (j.type === 'manual' && s.action !== 'group') leaves.push(s);
        walk(s.steps);
        walk(s.else);
        walk(s.catch);
      } else leaves.push(s);
    }
  };
  walk(j.steps);
  const auto = leaves.filter((s) => s.action !== 'manual');
  if (j.type === 'manual' && auto.length) {
    throw new IntentParseError(`${src}Type: manual journey "${j.name}" has automated steps ("${auto[0].intent}"); write them as "Manual: ..." or use Type: hybrid`, auto[0].intent, undefined, ['Type: hybrid']);
  }
  if (j.type === 'automated' && auto.length !== leaves.length) {
    const m = leaves.find((s) => s.action === 'manual')!;
    throw new IntentParseError(`${src}Type: automated journey "${j.name}" has a manual step ("${m.intent}"); use Type: hybrid`, m.intent, undefined, ['Type: hybrid']);
  }
}

function checkBlock(f: Frame, src: string, fail: (where: string, line: string, n: number, msg: string) => never): void {
  const s = f.step;
  const empty = !s.steps?.length;
  if (empty && !(s.action === 'if' && s.else?.length) && s.action !== 'try' && s.action !== 'group') {
    fail(`${src}line ${f.lineNumber}`, s.intent, f.lineNumber, `"${s.intent}" has no steps before its End`);
  }
}

/**
 * `Actors: manager as approver, customer as shopper with device "iPhone 13", courier on android app "com.x.courier"`:
 * a name, then `as <role>`, `on web|android|ios`, `app <id>`, `device <name>` in any order.
 */
export function parseActors(s: string, where: string): NonNullable<JourneyInput['actors']> {
  const { text, quotes } = protectQuotes(s);
  const out: NonNullable<JourneyInput['actors']> = {};
  for (const part of text.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = /^([A-Za-z_][\w.-]*)\s*(.*)$/.exec(p);
    if (!m) throw new Error(`${where}: expected "<name> [as <role>] [on android|ios] [app "<id>"] [with device "<name>"]" in Actors, got "${restoreQuotesText(p, quotes)}"`);
    const actor: NonNullable<JourneyInput['actors']>[string] = {};
    let rest = m[2].trim();
    while (rest) {
      let t: RegExpExecArray | null;
      if ((t = /^as\s+(?:role\s+)?(⟦\d+⟧|[\w.-]+)\s*/i.exec(rest))) actor.role = literal(t[1], quotes);
      else if ((t = /^on\s+(web|android|ios)\b\s*/i.exec(rest))) actor.platform = t[1].toLowerCase() as 'web' | 'android' | 'ios';
      else if ((t = /^(?:with\s+)?app\s+(⟦\d+⟧|\S+)\s*/i.exec(rest))) actor.app = literal(t[1], quotes);
      else if ((t = /^(?:with\s+|on\s+)?(?:the\s+)?device\s+(⟦\d+⟧|\S+)\s*/i.exec(rest))) actor.emulation = { ...(actor.emulation ?? {}), device: literal(t[1], quotes) };
      else if ((t = /^(?:with\s+)?locale\s+(⟦\d+⟧|\S+)\s*/i.exec(rest))) actor.emulation = { ...(actor.emulation ?? {}), locale: literal(t[1], quotes) };
      else throw new Error(`${where}: unknown actor option "${restoreQuotesText(rest, quotes)}" for ${m[1]} (use as <role>, on android|ios, app "<id>", with device "<name>", with locale <code>)`);
      rest = rest.slice(t[0].length).trim();
    }
    if (out[m[1]]) throw new Error(`${where}: actor ${m[1]} is declared twice`);
    out[m[1]] = actor;
  }
  return out;
}

function restoreQuotesText(s: string, quotes: string[]): string {
  return s.replace(/⟦(\d+)⟧/g, (_w, i: string) => `"${quotes[Number(i)]}"`);
}

/** `Actors:` header text for a journey's actors. */
export function actorsToText(actors: NonNullable<Journey['actors']>): string {
  return Object.entries(actors).map(([name, a]) => {
    const parts = [name];
    if (a.role) parts.push(`as ${/^[\w.-]+$/.test(a.role) ? a.role : quoteText(a.role)}`);
    if (a.platform) parts.push(`on ${a.platform}`);
    if (a.app) parts.push(`app ${quoteText(a.app)}`);
    const extra = Object.keys(a.emulation ?? {}).filter((k) => k !== 'device' && k !== 'locale');
    if (extra.length || a.capabilities) throw new Error(`actor ${name}: ${extra.length ? `emulation ${extra.join(', ')}` : 'capabilities'} cannot be expressed in .ez; keep this journey in YAML/JSON`);
    if (a.emulation?.device) parts.push(`with device ${quoteText(a.emulation.device)}`);
    if (a.emulation?.locale) parts.push(`with locale ${a.emulation.locale}`);
    return parts.join(' ');
  }).join(', ');
}

function emulation(j: JourneyInput): Emulation {
  return (j.emulation ??= {});
}

function applyHeader(j: JourneyInput, key: string, value: string, where: string): void {
  const yes = (v: string) => /^(?:yes|true|on|1|enabled?)$/i.test(v.trim());
  const unq = (v: string) => {
    const { text, quotes } = protectQuotes(v.trim());
    return literal(text, quotes);
  };
  switch (key) {
    case 'journey':
    case 'name': j.name = value; break;
    // A run-wide setup / teardown journey (docs/shared-data.md#run-wide-values): runs once before / after every other journey.
    case 'setup':
    case 'teardown': j.name = value; j.tags = [...new Set([...(j.tags ?? []), key])]; break;
    case 'id': j.id = value; break;
    case 'description': j.description = value; break;
    case 'tags': j.tags = [...new Set([...(j.tags ?? []).filter((t) => t === 'setup' || t === 'teardown'), ...splitList(value).map((t) => t.replace(/^@/, ''))])]; break;
    case 'role': j.role = value; break;
    case 'requirement':
    case 'requirements': j.requirements = value.split(',').map((s) => s.trim()).filter(Boolean); break;
    case 'risk': {
      const r = Number(value);
      if (!Number.isInteger(r) || r < 1 || r > 5) throw new Error(`${where}: Risk must be an integer 1-5`);
      j.risk = r;
      break;
    }
    case 'lock':
    case 'locks': j.locks = [...(j.locks ?? []), ...value.split(',').map((s) => s.trim()).filter(Boolean)]; break;
    case 'base url': case 'baseurl': j.baseUrl = value; break;
    case 'clock': j.clock = value.trim(); break;
    case 'variables': case 'vars': j.variables = { ...(j.variables ?? {}), ...parseVars(value, where) }; break;
    case 'lenses': j.lenses = splitList(value); break;
    case 'data': j.data = [...(j.data ?? []), ...parseData(value, where)]; break;
    case 'params': case 'parameters': j.params = value.split(',').map((s) => s.trim()).filter(Boolean); break;
    case 'returns': j.returns = value.split(',').map((s) => s.trim()).filter(Boolean); break;
    // ---------------------------------------------------------------- browser context emulation
    case 'device': emulation(j).device = unq(value); break;
    case 'viewport': {
      const m = /^(\d+)\s*[x×*,]\s*(\d+)$/.exec(value.trim());
      if (!m) throw new Error(`${where}: Viewport must look like 1280x720`);
      emulation(j).viewport = { width: Number(m[1]), height: Number(m[2]) };
      break;
    }
    case 'locale': emulation(j).locale = unq(value); break;
    case 'time zone': case 'timezone': emulation(j).timezoneId = unq(value); break;
    case 'color scheme': case 'colour scheme': case 'colorscheme': case 'colourscheme': {
      const v = value.trim().toLowerCase();
      if (!['light', 'dark', 'no-preference'].includes(v)) throw new Error(`${where}: Color scheme must be light, dark or no-preference`);
      emulation(j).colorScheme = v as 'light';
      break;
    }
    case 'reduced motion': case 'reducedmotion': emulation(j).reducedMotion = yes(value) || /reduce/i.test(value) ? 'reduce' : 'no-preference'; break;
    case 'geolocation': {
      const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(value.trim());
      if (!m) throw new Error(`${where}: Geolocation must look like "52.52, 13.40"`);
      emulation(j).geolocation = { latitude: Number(m[1]), longitude: Number(m[2]) };
      break;
    }
    case 'permissions': emulation(j).permissions = value.split(',').map((s) => s.trim()).filter(Boolean); break;
    case 'user agent': case 'useragent': emulation(j).userAgent = unq(value); break;
    case 'touch': emulation(j).hasTouch = yes(value); break;
    case 'offline': emulation(j).offline = yes(value); break;
    case 'http credentials': case 'httpcredentials': {
      const m = /^(.+?)\s*(?:\/|:)\s*(.+)$/.exec(value.trim());
      if (!m) throw new Error(`${where}: HTTP credentials must look like "user / \${password}"`);
      emulation(j).httpCredentials = { username: unq(m[1]), password: unq(m[2]) };
      break;
    }
    case 'story': j.story = { id: value.trim() }; break;
    case 'platform': {
      const p = value.trim().toLowerCase();
      if (p !== 'web' && p !== 'android' && p !== 'ios') throw new Error(`${where}: Platform must be web, android or ios, got "${value.trim()}"`);
      j.platform = p;
      break;
    }
    case 'capabilities': j.capabilities = { ...(j.capabilities ?? {}), ...parseCaps(value, where) }; break;
    case 'loaders': {
      const { text, quotes } = protectQuotes(value.trim());
      const items = /⟦\d+⟧/.test(text) ? [...text.matchAll(/⟦\d+⟧/g)].map((m) => literal(m[0], quotes)) : value.split(/\s*[;,]\s*/);
      j.loaders = [...(j.loaders ?? []), ...items.map((x) => x.trim()).filter(Boolean)];
      break;
    }
    case 'extra headers': case 'extraheaders': case 'headers': emulation(j).extraHTTPHeaders = { ...(emulation(j).extraHTTPHeaders ?? {}), ...parseVars(value, where) }; break;
    // "App:" is shared. "App: electron path/to/main.js [args]" (or "Electron: path/to/main.js") is a desktop
    // Electron journey (docs/desktop-and-legacy.md); any other value is the mobile app id/path for `Platform: android|ios`.
    case 'app': case 'electron': {
      const { text, quotes } = protectQuotes(value.trim());
      const words = text.split(/\s+/).filter(Boolean).map((w) => literal(w, quotes));
      if (key === 'app' && words[0]?.toLowerCase() !== 'electron') {
        j.app = unq(value);
        break;
      }
      if (key === 'app') words.shift();
      if (!words.length) throw new Error(`${where}: App: electron needs the app's main script or directory`);
      j.electron = { app: words[0], ...(words.length > 1 ? { args: words.slice(1) } : {}) };
      break;
    }
    case 'requires': j.requires = [...(j.requires ?? []), ...parseRequires(value, where)]; break;
    case 'depends on': case 'dependson': j.dependsOn = [...(j.dependsOn ?? []), ...parseDependsOn(value, where)]; break;
    case 'actors': j.actors = { ...(j.actors ?? {}), ...parseActors(value, where) }; break;
    case 'browsers': j.browsers = splitList(value).map((b) => b.toLowerCase()); break;
    case 'type': {
      const t = value.trim().toLowerCase();
      if (t !== 'manual' && t !== 'hybrid' && t !== 'automated') throw new Error(`${where}: Type must be manual, hybrid or automated, got "${value.trim()}"`);
      j.type = t;
      break;
    }
    case 'assignee': case 'assigned to': case 'assignedto': j.assignee = unq(value); break;
    case 'precondition': case 'preconditions': j.preconditions = value.trim(); break;
    default: throw new Error(`${where}: unknown header ${key}`);
  }
}

// ------------------------------------------------------------------ rendering

/** Fields that identify what a step does (not its children, id, intent or conditions). */
function signature(s: StepInput): string {
  const p = Step.parse({ ...s, id: 'x', intent: 'x', postconditions: [], steps: undefined, else: undefined, catch: undefined });
  return JSON.stringify([p.action, p.target?.locators ?? null, p.target?.frames ?? null, p.value ?? null, p.captureAs ?? null,
    p.api ?? null, p.db ?? null, p.handler ?? null, p.args ?? null, p.to?.locators ?? null, p.flow ?? null]);
}

/** Canonical plain-English line for a step's action (without post-conditions; blocks render their opener). */
export function stepToText(s: Step): string {
  const d = s.target?.description ?? '';
  const v = s.value ?? '';
  switch (s.action) {
    case 'navigate': {
      const mode = s.args?.mode;
      if (mode === 'reload') return 'Reload the page';
      if (mode === 'back') return 'Go back';
      if (mode === 'forward') return 'Go forward';
      return `Open ${quoteText(v)}`;
    }
    case 'click': {
      const a = s.args ?? {};
      if (a.newPage) return `Click ${d} and ${a.newPage === 'wait' ? 'wait for' : 'switch to'} the new tab`;
      if (a.modifiers) return `${(a.modifiers as string[]).join('+')}-click ${d}`;
      if (a.position) {
        const p = a.position as { x: number; y: number };
        return `Click ${d} at ${p.x}, ${p.y}`;
      }
      if (a.clickCount === 3) return `Triple-click ${d}`;
      if (a.button === 'middle') return `Middle-click ${d}`;
      return a.button === 'right' ? `Right-click ${d}` : `Click ${d}`;
    }
    case 'dblclick': return `Double-click ${d}`;
    case 'fill': return `Type ${quoteText(v)} into ${d}`;
    case 'clear': return `Clear ${d}`;
    case 'select': return `Select ${quoteText(v)} from ${d}`;
    case 'check': return `Check ${d}`;
    case 'uncheck': return `Uncheck ${d}`;
    case 'hover': return `Hover over ${d}`;
    case 'press': {
      const times = s.args?.times ? ` ${String(s.args.times)} times` : '';
      return s.target ? `Press ${v}${times} in ${d}` : `Press ${v}${times}`;
    }
    case 'upload': {
      const files = s.args?.files as string[] | undefined;
      if (s.args?.mode === 'drop') return `Drop file${(files?.length ?? 1) > 1 ? 's' : ''} ${(files ?? [v]).map((f) => quoteText(f)).join(', ')} onto ${d}`;
      if (files && files.length > 1) return `Upload ${files.map((f) => quoteText(f)).join(', ')} to ${d}`;
      return `Upload ${quoteText(files?.[0] ?? v)} to ${d}`;
    }
    case 'download': return `Download ${d} as ${s.captureAs ?? 'download'}`;
    case 'wait': {
      const adv = advancedWaitToText(s);
      if (adv) return adv;
      if (s.target) return `Wait for ${d}`;
      if (v) return `Wait ${v} ms`;
      const c = s.postconditions[0];
      if (c?.type === 'urlContains') return `Wait until the URL contains ${quoteText(c.value)}`;
      if (c?.type === 'pageContainsText') return `Wait for the text ${quoteText(c.value)}`;
      if (c?.type === 'hidden') return `Wait for ${c.target.description} to disappear`;
      return 'Wait';
    }
    case 'capture': return `Capture the ${String(s.args?.mode ?? 'text')} of ${d} as ${s.captureAs}`;
    case 'api': {
      const a = s.api!;
      if (a.graphql) {
        const vars = a.graphql.variables ? ` with variables ${quoteText(JSON.stringify(a.graphql.variables))}` : '';
        return `Send GraphQL query ${quoteText(a.graphql.query)} to ${quoteText(a.url)}${vars}${a.asRole ? ` as ${a.asRole}` : ''} and store as ${s.captureAs ?? 'response'}`;
      }
      if (a.soap) {
        return `Call SOAP action ${quoteText(a.soap.action ?? '')} on ${quoteText(a.url)} with body ${quoteText(a.soap.body)}${a.soap.version ? ` using SOAP ${a.soap.version}` : ''}${a.asRole ? ` as ${a.asRole}` : ''} and store as ${s.captureAs ?? 'response'}`;
      }
      const opts: string[] = [];
      const kv = (o: Record<string, string>) => Object.entries(o).map(([k, val]) => `${k}=${quoteText(val)}`).join(', ');
      if (a.query) opts.push(`with query ${kv(a.query)}`);
      if (a.form) opts.push(`with form ${kv(a.form)}`);
      if (a.multipart) opts.push(`with multipart ${kv(a.multipart)}`);
      if (a.bodyFile) opts.push(`with body from file ${quoteText(a.bodyFile)}`);
      if (a.headers) for (const [k, val] of Object.entries(a.headers)) opts.push(`with header ${quoteText(k)} = ${quoteText(val)}`);
      if (a.timeoutMs) opts.push(`with timeout ${a.timeoutMs} ms`);
      if (a.clientCertificate) opts.push(`with client certificate ${quoteText(a.clientCertificate)}`);
      if (s.args?.allowErrors) opts.push('with errors allowed');
      if (opts.length) {
        if (a.body !== undefined) opts.unshift(`with body ${quoteText(typeof a.body === 'string' ? a.body : JSON.stringify(a.body))}`);
        return `Call API ${quoteText(`${a.method} ${a.url}`)}${a.asRole ? ` as ${a.asRole}` : ''} ${opts.join(' ')} and store as ${s.captureAs ?? 'response'}`;
      }
      const body = a.body === undefined ? '' : ` with body ${quoteText(typeof a.body === 'string' ? a.body : JSON.stringify(a.body))}`;
      return `Call API ${quoteText(`${a.method} ${a.url}`)}${body}${a.asRole ? ` as ${a.asRole}` : ''} and store as ${s.captureAs ?? 'response'}`;
    }
    case 'db': {
      const q = s.db!;
      const named = queryStepToText(s);
      if (named) return named;
      const params = q.params?.length ? ` with params ${quoteText(JSON.stringify(q.params))}` : '';
      if (q.procedure) return `Call procedure ${quoteText(q.procedure)} on ${q.connection}${params} as ${s.captureAs ?? 'rows'}`;
      if (q.capture && q.capture !== 'rows') {
        const what = q.capture === 'cell' ? 'value' : q.capture === 'count' ? 'row count' : 'first row';
        return `Get the ${what} of query ${quoteText(q.sql)} on ${q.connection}${params} as ${s.captureAs ?? 'rows'}`;
      }
      return `Run query ${quoteText(q.sql)} on ${q.connection}${params} as ${s.captureAs ?? 'rows'}`;
    }
    case 'login': return v ? `Log in as ${v}` : 'Log in';
    case 'useData': {
      const a = (s.args ?? {}) as { entity?: string; as?: string; where?: Record<string, string> };
      const w = Object.entries(a.where ?? {}).map(([k, val]) => `${k}=${quoteText(val)}`).join(', ');
      return `Use data ${a.entity} as ${a.as}${w ? ` where ${w}` : ''}`;
    }
    case 'compareDocument': {
      const a = (s.args ?? {}) as { document?: string; against?: string; using?: string; mode?: string; expected?: string; tolerancePercent?: number; maxDiffPixels?: number; masks?: string };
      if (a.mode === 'visual') {
        const tol = a.tolerancePercent !== undefined ? ` within ${a.tolerancePercent}%` : a.maxDiffPixels !== undefined ? ` within ${a.maxDiffPixels} pixels` : '';
        return `Expect document ${a.document} to look like ${quoteText(String(a.expected))}${tol}${typeof a.masks === 'string' ? ` ignoring ${a.masks}` : ''}${s.captureAs ? ` and store as ${s.captureAs}` : ''}`;
      }
      return `Compare document ${a.document} to ${quoteText(String(a.against))}${a.using ? ` using ${a.using}` : ''}${s.captureAs ? ` and store as ${s.captureAs}` : ''}`;
    }
    case 'custom': {
      const args = Object.entries(s.args ?? {}).map(([k, val]) => `${k}=${quoteText(String(val))}`).join(', ');
      return `Run step ${quoteText(s.handler ?? '')}${args ? ` with ${args}` : ''}`;
    }
    case 'mobile': return mobileStepToText(s);
    case 'actor': return s.steps !== undefined ? `As ${/^[A-Za-z_][\w.-]*$/.test(v) ? v : quoteText(v)}:` : `Switch to user ${quoteText(v)}`;
    case 'parallel': return 'In parallel:';
    case 'assert': {
      const c = s.postconditions[0];
      if (!c) throw new Error(`assert step ${s.id} has no post-conditions`);
      return `${s.soft ? 'Soft expect' : 'Assert that'} ${conditionToText(c)}`;
    }
    default:
      return advancedStepToText(s);
  }
}

function annotate(text: string, s: Step, parsed: StepInput): string {
  const parts: string[] = [];
  if (s.id !== defaultStepId(text)) parts.push(`id=${s.id}`);
  if (s.optional) parts.push('optional');
  if (s.soft && !parsed.soft) parts.push('soft');
  if (s.timeoutMs) parts.push(`timeout=${s.timeoutMs}ms`);
  if (s.risk) parts.push(`risk=${s.risk}`);
  if (s.poll && JSON.stringify(s.poll) !== JSON.stringify(parsed.poll)) {
    if (s.poll.attempts !== undefined) parts.push(`retry=${s.poll.attempts}`);
    if (s.poll.intervalMs !== undefined) parts.push(`every=${s.poll.intervalMs}ms`);
  }
  return parts.length ? `${text} [${parts.join(' ')}]` : text;
}

/** A step renders as a block (opener + children + End) when it is a block action with children. */
function isBlock(s: Step): boolean {
  return BLOCK_ACTIONS.has(s.action) && s.steps !== undefined;
}

/** Choose the line for a step: its own intent when that parses back to the same step, else the canonical text. */
function lineFor(s: Step, idx: number): { text: string; parsed: StepInput; inline?: boolean } {
  const isAssert = s.action === 'assert';
  const block = isBlock(s);
  const candidates: string[] = [];
  const intentLooksLikeExpect = EXPECT.test(s.intent.trim()) && !SOFT.test(s.intent.trim());
  if (!(isAssert && intentLooksLikeExpect && idx > 0)) candidates.push(s.intent.trim());
  candidates.push(stepToText(s));
  const want = signature(s);
  const wantFirst = isAssert ? JSON.stringify(s.postconditions[0]) : '';
  for (const c of candidates) {
    try {
      const parsed = parseIntent(c);
      if (signature(parsed) !== want) continue;
      // A single-line block ("Repeat 3 times: press Tab") is kept when it carries exactly this block's only child.
      if (block && (parsed.steps?.length ?? 0) > 0) {
        const same = parsed.steps!.length === 1 && s.steps!.length === 1 && !s.else?.length && !s.catch?.length &&
          JSON.stringify(Step.parse(parsed.steps![0])) === JSON.stringify(s.steps![0]);
        if (same) return { text: c, parsed, inline: true };
        continue;
      }
      if (!block && parsed.steps !== undefined && s.steps === undefined) continue;
      if (isAssert && JSON.stringify(Step.parse(parsed).postconditions[0]) !== wantFirst) continue;
      if (!isAssert && s.action === 'wait' && !s.target && !s.value && !s.args &&
        JSON.stringify(Step.parse(parsed).postconditions[0]) !== JSON.stringify(s.postconditions[0])) continue;
      return { text: c, parsed };
    } catch {
      // Try the next candidate text.
    }
  }
  throw new Error(`Step ${s.id} ("${s.intent}") cannot be expressed in .ez; keep this journey in YAML/JSON`);
}

function renderSteps(steps: Step[], depth: number, out: string[], top: boolean): void {
  const pad = '  '.repeat(depth);
  steps.forEach((s, idx) => {
    if (s.action === 'manual') {
      let text = `Manual: ${s.value ?? ''}`;
      try {
        const own = parseIntent(s.intent);
        if (own.action === 'manual' && own.value === s.value) text = s.intent;
      } catch {
        // the canonical form
      }
      out.push(pad + annotate(text, s, parseIntent(text)));
      const a = (s.args ?? {}) as { expected?: string[]; attachments?: string[] };
      for (const e of a.expected ?? []) out.push(`${pad}  Expected: ${e}`);
      for (const f of a.attachments ?? []) out.push(`${pad}  Attachment: ${f}`);
      for (const c of s.postconditions) out.push(`${pad}  Expect ${conditionToText(c)}`);
      return;
    }
    const { text, parsed, inline } = lineFor(s, top ? idx : idx + 1);
    out.push(pad + annotate(text, s, parsed));
    if (isBlock(s) && !inline) {
      renderSteps(s.steps ?? [], depth + 1, out, false);
      if (s.else?.length) {
        out.push(`${pad}Otherwise`);
        renderSteps(s.else, depth + 1, out, false);
      }
      if (s.catch?.length) {
        out.push(`${pad}On failure`);
        renderSteps(s.catch, depth + 1, out, false);
      }
      out.push(`${pad}End`);
    }
    // Post-conditions already carried by the line itself are not repeated.
    const parsedConds = Step.parse(parsed).postconditions.length;
    for (const c of s.postconditions.slice(parsedConds)) out.push(`${pad}  Expect ${conditionToText(c)}`);
  });
}

/**
 * Render a Journey as an .ez script that parses back to an equivalent journey.
 * Throws if a step cannot be expressed in plain English (e.g. hand-written
 * CSS-only targets whose description does not reproduce the locators).
 */
export function journeyToEzScript(journey: Journey): string {
  const kind = journey.tags.includes('setup') ? 'Setup' : journey.tags.includes('teardown') ? 'Teardown' : 'Journey';
  const out: string[] = [`${kind}: ${journey.name}`];
  if (journey.id !== slugify(journey.name)) out.push(`Id: ${journey.id}`);
  if (journey.description) out.push(`Description: ${journey.description}`);
  const tags = journey.tags.filter((t) => kind === 'Journey' || t !== kind.toLowerCase());
  if (tags.length) out.push(`Tags: ${tags.map((t) => `@${t.replace(/^@/, '')}`).join(' ')}`);
  if (journey.role) out.push(`Role: ${journey.role}`);
  if (journey.requirements.length) out.push(`Requirements: ${journey.requirements.join(', ')}`);
  if (journey.risk !== 3) out.push(`Risk: ${journey.risk}`);
  if (journey.type) out.push(`Type: ${journey.type}`);
  if (journey.assignee) out.push(`Assignee: ${journey.assignee}`);
  if (journey.preconditions) out.push(`Preconditions: ${journey.preconditions}`);
  if (journey.locks?.length) out.push(`Locks: ${journey.locks.join(', ')}`);
  if (journey.baseUrl) out.push(`Base URL: ${journey.baseUrl}`);
  const vars = Object.entries(journey.variables);
  if (vars.length) out.push(`Variables: ${vars.map(([k, v]) => `${k}=${quoteText(v)}`).join(', ')}`);
  if (journey.lenses.length) out.push(`Lenses: ${journey.lenses.join(', ')}`);
  if (journey.loaders?.length) out.push(`Loaders: ${journey.loaders.map((l) => quoteText(l)).join(', ')}`);
  if (journey.electron) {
    if (journey.electron.executable) throw new Error('an Electron executable cannot be expressed in .ez (use config desktop.electron.executablePath); keep this journey in YAML/JSON');
    out.push(`App: electron ${[journey.electron.app, ...(journey.electron.args ?? [])].map((a) => quoteText(a)).join(' ')}`);
  }
  if (journey.data.length) {
    out.push(`Data: ${journey.data.map((d) => {
      const w = Object.entries(d.where).map(([k, v]) => `${k}=${quoteText(v)}`).join(', ');
      return `${d.entity} as ${d.as}${w ? ` where ${w}` : ''}`;
    }).join('; ')}`);
  }
  for (const r of journey.requires ?? []) out.push(`Requires: ${requiresToText(r)}`);
  if (journey.dependsOn?.length) out.push(`Depends on: ${journey.dependsOn.map(dependsOnToText).join('; ')}`);
  if (journey.params?.length) out.push(`Params: ${journey.params.join(', ')}`);
  if (journey.returns?.length) out.push(`Returns: ${journey.returns.join(', ')}`);
  if (journey.platform) out.push(`Platform: ${journey.platform}`);
  if (journey.actors && Object.keys(journey.actors).length) out.push(`Actors: ${actorsToText(journey.actors)}`);
  if (journey.browsers?.length) out.push(`Browsers: ${journey.browsers.join(', ')}`);
  if (journey.clock) out.push(`Clock: ${journey.clock}`);
  if (journey.story) out.push(`Story: ${journey.story.id}`);
  if (journey.app) out.push(`App: ${quoteText(journey.app)}`);
  const caps = Object.entries(journey.capabilities ?? {});
  if (caps.length) out.push(`Capabilities: ${caps.map(([k, v]) => `${k}=${typeof v === 'string' ? quoteText(v) : String(v)}`).join(', ')}`);
  const e = journey.emulation;
  if (e) {
    if (e.device) out.push(`Device: ${e.device}`);
    if (e.viewport) out.push(`Viewport: ${e.viewport.width}x${e.viewport.height}`);
    if (e.locale) out.push(`Locale: ${e.locale}`);
    if (e.timezoneId) out.push(`Timezone: ${e.timezoneId}`);
    if (e.colorScheme) out.push(`Color scheme: ${e.colorScheme}`);
    if (e.reducedMotion) out.push(`Reduced motion: ${e.reducedMotion}`);
    if (e.geolocation) {
      if (e.geolocation.accuracy !== undefined) throw new Error('geolocation accuracy cannot be expressed in .ez; keep this journey in YAML/JSON');
      out.push(`Geolocation: ${e.geolocation.latitude}, ${e.geolocation.longitude}`);
    }
    if (e.permissions?.length) out.push(`Permissions: ${e.permissions.join(', ')}`);
    if (e.userAgent) out.push(`User agent: ${e.userAgent}`);
    if (e.hasTouch !== undefined) out.push(`Touch: ${e.hasTouch ? 'on' : 'off'}`);
    if (e.offline !== undefined) out.push(`Offline: ${e.offline ? 'yes' : 'no'}`);
    if (e.httpCredentials) out.push(`HTTP credentials: ${quoteText(e.httpCredentials.username)} / ${quoteText(e.httpCredentials.password)}`);
    if (e.extraHTTPHeaders) out.push(`Headers: ${Object.entries(e.extraHTTPHeaders).map(([k, v]) => `${k}=${quoteText(v)}`).join(', ')}`);
    if (e.isMobile !== undefined) throw new Error('isMobile cannot be expressed in .ez (use Device:); keep this journey in YAML/JSON');
  }
  out.push('');
  renderSteps(journey.steps, 0, out, true);
  if (journey.examplesFrom) out.push('', examplesSourceToText(journey.examplesFrom));
  if (journey.examples?.length) {
    const cols = Object.keys(journey.examples[0]);
    const cell = (v: string) => (/^[^|"']*$/.test(v) && v.trim() === v && v !== '' ? v : quoteText(v));
    out.push('', 'Examples:', `  | ${cols.join(' | ')} |`);
    for (const r of journey.examples) out.push(`  | ${cols.map((c) => cell(r[c] ?? '')).join(' | ')} |`);
  }
  return out.join('\n') + '\n';
}
