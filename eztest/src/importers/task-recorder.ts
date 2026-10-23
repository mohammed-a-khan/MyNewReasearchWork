/**
 * Dynamics 365 Finance & Operations Task Recorder / RSAT recording importer.
 *
 * Recordings are XML trees of task nodes and user actions. The parser is
 * tolerant: an element is recognised by its type (the `i:type` attribute,
 * a `UserActionType`/`Type` child, or its element name) and by the fields it
 * carries (MenuItemName, CommandName, ControlLabel, Value, Operator...):
 *
 *   menu item navigation  -> Open "/?mi=<MenuItemName>"
 *   set a control value   -> Set the "<ControlLabel>" field to "<Value>" (dropdown/checkbox aware)
 *   command / button      -> Click the "<ControlLabel>" button
 *   validation            -> Expect the "<ControlLabel>" field has value "<Value>"
 *   task / info nodes     -> section comments
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { quoteText } from '../intent/index.js';
import { JourneyDraft, oneLine, type SourceRef } from './builder.js';
import { assembleReport } from './report.js';
import type { ImportReport, ImporterOptions } from './types.js';

export interface TaskRecorderOptions extends ImporterOptions {
  /** URL for a menu item. Default `/?mi=<name>` (`mi=action:<name>` / `mi=output:<name>` for those types), plus `&cmp=<company>`. */
  menuItemUrl?: (name: string, type: string | undefined) => string;
  /** Legal entity added to menu item URLs as `cmp=`. */
  company?: string;
}

interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

type Raw = Record<string, unknown>;

function toTree(items: Raw[]): XNode[] {
  const out: XNode[] = [];
  for (const it of items) {
    const attrs: Record<string, string> = {};
    const a = it[':@'] as Record<string, unknown> | undefined;
    if (a) for (const [k, v] of Object.entries(a)) attrs[k.replace(/^@_/, '')] = String(v);
    for (const [k, v] of Object.entries(it)) {
      if (k === ':@') continue;
      if (k === '#text') {
        out.push({ name: '#text', attrs: {}, children: [], text: String(v) });
        continue;
      }
      const children = Array.isArray(v) ? toTree(v as Raw[]) : [];
      out.push({ name: k, attrs, children, text: children.filter((c) => c.name === '#text').map((c) => c.text).join('') });
    }
  }
  return out;
}

const field = (n: XNode, ...names: string[]): string | undefined => {
  for (const nm of names) {
    const c = n.children.find((x) => x.name.toLowerCase() === nm.toLowerCase());
    if (c && c.text.trim()) return c.text.trim();
    if (n.attrs[nm] !== undefined && n.attrs[nm].trim()) return n.attrs[nm].trim();
  }
  return undefined;
};

const ACTION_FIELDS = ['MenuItemName', 'CommandName', 'ControlLabel', 'ControlName', 'Value'];

function nodeType(n: XNode): string {
  return [n.attrs.type, field(n, 'UserActionType', 'ActionType', 'Type'), n.name].filter(Boolean).join(' ');
}

const q = (s: string) => quoteText(s);

function safe(fn: () => void, onError: (e: Error) => void): void {
  try {
    fn();
  } catch (e) {
    onError(e as Error);
  }
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Import a Task Recorder / RSAT recording XML. */
export function importTaskRecorder(xml: string, opts: TaskRecorderOptions = {}): ImportReport {
  const file = opts.file ?? 'recording.xml';
  const ids = opts.ids ?? new Set<string>();
  const warnings: string[] = [];
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    const line = valid.err.line ?? 1;
    return assembleReport([], [file], [], [{ file, line, original: oneLine(xml.split('\n')[line - 1] ?? ''), reason: `invalid XML: ${valid.err.msg}` }]);
  }
  let tree: XNode[];
  try {
    const parser = new XMLParser({
      preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false,
      parseAttributeValue: false, trimValues: true, processEntities: true,
    });
    tree = toTree(parser.parse(xml) as Raw[]);
  } catch (e) {
    return assembleReport([], [file], [], [{ file, line: 1, original: oneLine(xml.slice(0, 120)), reason: `invalid XML: ${(e as Error).message}` }]);
  }
  const root = tree.find((n) => n.name !== '?xml' && n.name !== '#text');
  if (!root) return assembleReport([], [file], [`${file}: empty XML document`]);
  const name = field(root, 'Name', 'Title') ?? file.replace(/^.*[\\/]/, '').replace(/\.xml$/i, '');
  const description = field(root, 'Description');
  const d = new JourneyDraft(name, { kind: 'task-recorder', file, line: 1, ids, tags: [...(opts.tags ?? []), 'd365'], ...(description ? { description } : {}) });

  // Line numbers: locate each action's identifying text in the source, moving forward.
  let cursor = 0;
  const lineOf = (n: XNode): number => {
    for (const key of [field(n, 'Id'), field(n, 'Description'), field(n, 'ControlName'), field(n, 'MenuItemName'), field(n, 'ControlLabel')]) {
      if (!key) continue;
      const found = xml.indexOf(xmlEscape(key), cursor);
      if (found >= 0) {
        const open = xml.lastIndexOf(`<${n.name}`, found);
        const at = open >= cursor ? open : found;
        cursor = found;
        return xml.slice(0, at).split('\n').length;
      }
    }
    return xml.slice(0, cursor).split('\n').length;
  };
  const menuUrl = opts.menuItemUrl ?? ((mi: string, type?: string) => {
    const t = (type ?? '').toLowerCase();
    const prefix = t.includes('action') ? 'action:' : t.includes('output') ? 'output:' : '';
    return `/?${opts.company ? `cmp=${encodeURIComponent(opts.company)}&` : ''}mi=${prefix}${mi}`;
  });

  const target = (n: XNode, kind: 'field' | 'dropdown' | 'checkbox' | 'button'): string | undefined => {
    const label = field(n, 'ControlLabel', 'Label');
    if (label) return `the ${q(label)} ${kind}`;
    const cn = field(n, 'ControlName');
    if (cn && !cn.includes('"')) return kind === 'field' ? `[data-dyn-controlname="${cn}"] input` : `[data-dyn-controlname="${cn}"]`;
    return undefined;
  };

  const action = (n: XNode): void => {
    const type = nodeType(n);
    const src: SourceRef = { line: lineOf(n), original: field(n, 'Description') ?? `${n.attrs.type ?? n.name} ${field(n, 'ControlLabel') ?? field(n, 'ControlName') ?? ''}` };
    const value = field(n, 'Value', 'ExpectedValue');
    const controlType = (field(n, 'ControlType') ?? '').toLowerCase();
    const menuItem = field(n, 'MenuItemName');
    if (/menuitem|navigat/i.test(type) || menuItem) {
      if (!menuItem) return void d.addTodo(src, 'navigation without a menu item name');
      const url = menuUrl(menuItem, field(n, 'MenuItemType'));
      return void d.step(`Open ${q(url)}`, src, { action: 'navigate', value: url });
    }
    if (/validat|verif|assert/i.test(type) || field(n, 'Operator', 'ComparisonOperator', 'ValidationType')) {
      const op = (field(n, 'Operator', 'ComparisonOperator') ?? 'Equal').toLowerCase();
      const t = target(n, 'field');
      if (!t) return void d.addTodo(src, 'validation without a control label or name', 'assertion');
      if (value === undefined) return void d.addTodo(src, 'validation without an expected value', 'assertion');
      if (!/^(?:eq|equal|equals|isequal|isequalto|=|==)$/.test(op)) return void d.addTodo(src, `validation operator "${op}" is not converted`, 'assertion');
      return void d.expect(`${t} has value ${q(value)}`, src, { type: 'valueEquals' });
    }
    if (/property|input|setvalue|enter|value/i.test(type.replace(/UserAction/i, '')) || (value !== undefined && (field(n, 'ControlLabel') || field(n, 'ControlName')))) {
      if (value === undefined) return void d.addTodo(src, 'set-value action without a value');
      if (/combo|dropdown|enum|radio/.test(controlType)) {
        const t = target(n, 'dropdown');
        if (!t) return void d.addTodo(src, 'control has no label or name');
        return void d.step(`Select ${q(value)} from ${t}`, src, { action: 'select', value });
      }
      if (/check|toggle|boolean/.test(controlType)) {
        const t = target(n, 'checkbox');
        if (!t) return void d.addTodo(src, 'control has no label or name');
        const on = /^(?:yes|true|1|on|checked)$/i.test(value);
        if (!on && !/^(?:no|false|0|off|unchecked)$/i.test(value)) return void d.addTodo(src, `checkbox value "${value}" is not yes/no`);
        return void d.step(`${on ? 'Check' : 'Uncheck'} ${t}`, src, { action: on ? 'check' : 'uncheck' });
      }
      const t = target(n, 'field');
      if (!t) return void d.addTodo(src, 'control has no label or name');
      return void d.step(`Set ${t} to ${q(value)}`, src, { action: 'fill', value });
    }
    if (/command|click|button/i.test(type) || field(n, 'CommandName') || /button/.test(controlType)) {
      const t = target(n, 'button');
      if (!t) return void d.addTodo(src, 'command without a control label or name');
      return void d.step(`Click ${t}`, src, { action: 'click' });
    }
    d.addTodo(src, `user action type "${n.attrs.type ?? n.name}" is not converted`);
  };

  const walk = (nodes: XNode[]): void => {
    for (const n of nodes) {
      if (n.name === '#text') continue;
      const type = nodeType(n);
      const kids = n.children.filter((c) => c.name !== '#text');
      const isTask = /task(?:node|step)?\b|group/i.test(type) && kids.some((c) => /childnodes|nodes|steps|useractions/i.test(c.name));
      const isInfo = /info|annotation|comment|note/i.test(n.attrs.type ?? '');
      const hasActionFields = ACTION_FIELDS.some((f) => field(n, f) !== undefined);
      if (isTask) {
        const desc = field(n, 'Description', 'Name');
        if (desc) d.comment(`Task: ${desc}`);
        walk(kids.filter((c) => /childnodes|nodes|steps|useractions/i.test(c.name)));
      } else if (isInfo) {
        const desc = field(n, 'Description', 'Text', 'Name');
        if (desc) d.comment(`Info: ${desc}`);
      } else if (hasActionFields && (n.attrs.type || /node|useraction|action|step|validation/i.test(n.name))) {
        safe(() => action(n), (e) => d.addTodo({ line: lineOf(n), original: field(n, 'Description') ?? n.name }, `conversion error: ${e.message}`));
      } else {
        walk(kids);
      }
    }
  };
  walk(root.children);
  if (d.steps === 0 && d.todo.length === 0) warnings.push(`${file}: no Task Recorder user actions found`);
  return assembleReport([d], [file], warnings);
}
