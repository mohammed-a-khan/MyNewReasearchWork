/**
 * Code journeys (eztest/sdk) in the editor: autocomplete for `ui.`, `db.`,
 * `expect.` and the other SDK surfaces, and an outline of the lines that are
 * steps (SDK calls the runner reports, traces and can break on).
 * Lightweight on purpose: TypeScript types are checked by `tsc` in the
 * project, the Studio only checks syntax.
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { OutlineItem } from './ezlang.js';

type Member = [label: string, signature: string, info: string];

const ACTION_OPTS = 'o?: { expect?, timeoutMs?, optional? }';

export const SDK_MEMBERS: Record<string, Member[]> = {
  ui: [
    ['open', `(url: string, ${ACTION_OPTS})`, 'Open a URL or a path relative to the base URL.'],
    ['click', `(target, ${ACTION_OPTS})`, 'Click an element. `expect` post-conditions make healing verifiable.'],
    ['dblclick', '(target, o?)', 'Double-click an element.'],
    ['hover', '(target, o?)', 'Hover over an element.'],
    ['fill', '(target, value, o?)', "Replace a field's content."],
    ['clear', '(target, o?)', 'Clear a field.'],
    ['select', '(target, option, o?)', 'Choose an option by value or label.'],
    ['check', '(target, o?)', 'Tick a checkbox.'],
    ['uncheck', '(target, o?)', 'Untick a checkbox.'],
    ['press', '(key, target?, o?)', 'Press a key (Enter, Tab, Control+A …).'],
    ['upload', '(target, files, o?)', 'Attach project files to a file input.'],
    ['download', '(target, o?): Download', 'Click a download; the file is kept as evidence.'],
    ['waitFor', "(target, state = 'visible', o?)", 'Wait for an element state.'],
    ['waitForUrl', '(pattern, o?)', 'Wait until the URL matches.'],
    ['wait', '(ms)', 'A fixed pause (prefer post-conditions).'],
    ['text', '(target): string', 'Visible text of an element.'],
    ['value', '(target): string', 'Value of an input.'],
    ['attribute', '(target, name): string | null', 'An attribute of an element.'],
    ['table', '(target): rows', 'Rows of an HTML table, by header.'],
    ['count', '(target): number', 'How many elements match.'],
    ['texts', '(target): string[]', 'Texts of all matching elements.'],
    ['url', '(): string', 'The current URL.'],
    ['title', '(): string', 'The page title.'],
    ['isVisible', '(target, { timeoutMs? }): boolean', 'Visible? Never fails the journey.'],
    ['isHidden', '(target, o?): boolean', 'Hidden? Never fails the journey.'],
    ['isEnabled', '(target, o?): boolean', 'Enabled? Never fails the journey.'],
    ['isChecked', '(target, o?): boolean', 'Checked? Never fails the journey.'],
    ['login', '(role?)', 'Sign in as an Identity Vault role.'],
    ['screenshot', '(name?)', 'Screenshot as evidence.'],
    ['scrollIntoView', '(target, o?)', 'Scroll an element into view.'],
    ['focus', '(target, o?)', 'Focus an element.'],
    ['reload', '(o?)', 'Reload the page.'],
    ['back', '(o?)', 'Go back.'],
    ['page', '(): Page', 'The raw browser page from eztest/browser (not verified or traced; prefer ui.*).'],
  ],
  db: [
    ['query', '(name, params?, o?): Row[]', 'Rows of a named catalogue query (bound :params).'],
    ['row', '(name, params?): Row', 'First row of a catalogue query (fails when none).'],
    ['value', '(name, params?): unknown', 'First cell of a catalogue query.'],
    ['count', '(name, params?): number', 'Row count of a catalogue query.'],
    ['on', '(connection)', 'The same surface on a connection alias.'],
    ['sql', '`SELECT … ${value}`: Row[]', 'Tagged template: values are bind parameters, never text.'],
    ['sqlValue', '`SELECT … ${value}`', 'Tagged template returning the first cell.'],
    ['procedure', '(name, params, out?)', 'Call a stored procedure.'],
  ],
  api: [
    ['get', '(url, o?): ApiResponse', 'HTTP GET (base URL, role tokens, mTLS, evidence).'],
    ['post', '(url, body?, o?): ApiResponse', 'HTTP POST.'],
    ['put', '(url, body?, o?)', 'HTTP PUT.'],
    ['patch', '(url, body?, o?)', 'HTTP PATCH.'],
    ['delete', '(url, o?)', 'HTTP DELETE.'],
    ['request', '(method, url, body?, o?)', 'Any method.'],
    ['path', '(res, "$.a.b")', 'A JSON path into a response body.'],
  ],
  files: [
    ['rows', '(path | download, { sheet? }): rows', 'Rows of a CSV, XLSX or JSON file, or of a download.'],
    ['readCsv', '(path)', 'CSV rows.'],
    ['readXlsx', '(path, { sheet? })', 'Sheet rows.'],
    ['readJson', '(path)', 'Parsed JSON.'],
    ['readText', '(path)', 'File text.'],
    ['readPdf', '(path | download): { text, pages, fields }', 'PDF text layer.'],
    ['writeCsv', '(path, rows)', 'Write rows as CSV (kept as evidence).'],
    ['writeXlsx', '(path, rows, { sheet? })', 'Write rows to a workbook.'],
    ['writeJson', '(path, value)', 'Write JSON.'],
    ['writeText', '(path, text)', 'Write text.'],
    ['exists', '(path): boolean', 'Does the file exist?'],
    ['path', '(path): string', 'Absolute path of a project path.'],
  ],
  data: [
    ['row', '', 'The Examples row of a data-driven journey.'],
    ['rows', '(file, { sheet?, where? })', 'Rows of a data file, filtered.'],
    ['lease', '(entity, where?, { as?, strategy? })', 'A record from the Test Data Fabric.'],
  ],
  dates: [
    ['today', '(tz?): YYYY-MM-DD', 'Today (in a time zone).'],
    ['now', '(tz?): ISO', 'Now.'],
    ['addDays', '(d, n)', 'Add days.'],
    ['addMonths', '(d, n)', 'Add months.'],
    ['addBusinessDays', '(d, n, holidays?)', 'Add business days (configured calendar).'],
    ['nextBusinessDay', '(d)', 'Next business day.'],
    ['previousBusinessDay', '(d)', 'Previous business day.'],
    ['isBusinessDay', '(d): boolean', 'Is a business day?'],
    ['daysBetween', '(a, b): number', 'Whole days between.'],
    ['format', "(d, 'YYYY-MM-DD', tz?)", 'Format a date.'],
    ['toUSDate', '(d)', 'MM/DD/YYYY.'],
    ['inZone', '(d, tz)', 'ISO local time with offset.'],
    ['startOfMonth', '(d?)', 'First day of the month.'],
    ['endOfMonth', '(d?)', 'Last day of the month.'],
  ],
  vars: [
    ['get', '(key)', 'A variable (dotted paths).'],
    ['set', '(key, value)', 'Set a variable (visible to .ez as ${key}).'],
    ['text', '(key): string', 'A variable as text.'],
    ['has', '(key): boolean', 'Is it set?'],
    ['all', '()', 'Every variable.'],
    ['row', '()', 'The Examples row.'],
    ['resolve', '(text)', 'Replace ${name} placeholders.'],
  ],
  log: [
    ['info', '(message, data?)', 'A note in the run log.'],
    ['warn', '(message, data?)', 'A warning on the current step.'],
    ['error', '(message, data?)', 'An error note on the current step.'],
    ['debug', '(message, data?)', 'A debug note.'],
  ],
  identity: [
    ['loginAs', '(role?)', 'Sign in as a role (verified session reuse, MFA).'],
    ['totp', '(secret): string', 'Current TOTP code.'],
  ],
  expect: [
    ['ui', '', 'UI checks run as post-conditions (text, visible, hidden, count, url, title, page, that).'],
    ['api', '(res)', 'status(n), json(path), header(name), fasterThan(ms).'],
    ['rows', '(rows)', 'toHaveCount, toContainRow, toEqual(other, { key }), toBeSortedBy.'],
    ['db', '(query, params?)', 'Rows of a catalogue query: toHaveCount, toEqual …'],
    ['soft', '', 'The same matchers, soft: failures are recorded and the journey goes on.'],
  ],
  'expect.ui': [
    ['text', '(target).toBe | toContain | toMatch', 'Element text.'],
    ['value', '(target).toBe', 'Input value.'],
    ['visible', '(target)', 'Element is visible.'],
    ['hidden', '(target)', 'Element is hidden.'],
    ['enabled', '(target)', 'Element is enabled.'],
    ['disabled', '(target)', 'Element is disabled.'],
    ['checked', '(target)', 'Element is checked.'],
    ['count', '(target).toBe(n)', 'Exactly n elements.'],
    ['url', '().toContain | toMatch', 'The URL.'],
    ['title', '().toContain', 'The title.'],
    ['page', '().toContainText | notToContainText', 'Page text.'],
    ['that', "('an .ez Expect phrase')", 'Any .ez expectation.'],
  ],
};

const TOP: Member[] = [
  ['journey', "('Name', { tags, role, risk }, async ({ ui, db, expect }) => { … })", 'Declare a code journey.'],
  ['step', "('Name', async () => { … })", 'A nested, reported step.'],
  ['screen', "('Name', { key: { css, label } })", 'A screen (page object) with locator candidates.'],
  ['run', "('journey-id', params)", 'Run an .ez or library journey.'],
  ['soft', '(async () => { … })', 'Expectations inside are soft.'],
  ['codeStep', '(async (ctx, params) => { … })', 'A code step callable from .ez with "Run code".'],
];

const opts = (list: Member[]): Completion[] => list.map(([label, sig, info]) => ({ label, detail: sig, info, type: sig.startsWith('(') || sig.startsWith('`') ? 'method' : 'property' }));

/** Completions after `ui.`, `db.`, `expect.ui.` … and SDK function names at the start of a word. */
export function sdkCompletions(ctx: CompletionContext): CompletionResult | null {
  const member = ctx.matchBefore(/\b(expect(?:\.soft)?(?:\.ui)?|ui|db(?:\.on\([^)]*\))?|api|files|data|dates|vars|log|identity)\.(\w*)$/);
  if (member) {
    const m = /^(.*)\.(\w*)$/.exec(member.text)!;
    let key = m[1].replace(/^db\.on\(.*\)$/, 'db').replace('.soft', '');
    if (key === 'expect.ui') key = 'expect.ui';
    const list = SDK_MEMBERS[key];
    if (!list) return null;
    return { from: member.to - m[2].length, options: opts(list), validFor: /^\w*$/ };
  }
  const word = ctx.matchBefore(/\b\w+$/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  return { from: word.from, options: opts(TOP), validFor: /^\w*$/ };
}

const STEP_LINE = /\bawait\s+(?:ui|api|db|files|data|identity|expect|e|step|run|soft)\b\s*[.(]/;

/** Lines of a code file that are steps (SDK calls the runner reports and the debugger can stop at). */
export function codeOutline(text: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    if (STEP_LINE.test(raw)) out.push({ line: i + 1, text: t.replace(/\s*\{\s*$/, '').slice(0, 160), kind: 'step' });
  });
  return out;
}

/** journey() calls with their lines (for choosing which journey of a file to debug). */
export function codeJourneyLines(text: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = /^\s*journey\s*\(\s*(['"`])(.*?)\1/.exec(raw);
    if (m) out.push({ name: m[2], line: i + 1 });
  });
  return out;
}
