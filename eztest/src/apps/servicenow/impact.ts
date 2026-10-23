/**
 * ServiceNow change impact.
 *
 *  - Update sets: every sys_update_xml record is classified by its name and
 *    payload (dictionary entries, field labels, choices, UI policies and
 *    their actions, UI actions, business rules, form layouts, ACLs, catalog
 *    items and variables) and compared with the live dictionary, so a label
 *    change, a newly mandatory field, a removed choice or a deactivated UI
 *    action becomes an AppChange.
 *  - Upgrades: records the upgrade skipped because they are customised
 *    (sys_upgrade_history_log) are review items for the journeys that use them.
 *  - Dictionary snapshots of two instances (or before/after a commit) diff
 *    through the shared snapshot differ.
 */
import { XMLParser } from 'fast-xml-parser';
import type { Step } from '../../core/index.js';
import { makeSnapshot, type AppChange, type AppSnapshot, type StepScoper } from '../common/impact.js';
import { normalizeLabel } from '../common/kit.js';
import type { ServiceNowClient, SnTable, SnUpdateXml, SnSkipped } from './client.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });

/** Snapshot the dictionary of the configured tables. */
export async function snapshotServiceNow(client: ServiceNowClient, tables: string[], o: { source?: string; release?: string } = {}): Promise<AppSnapshot> {
  const objs = [];
  for (const t of tables) {
    const d = await client.describe(t);
    objs.push({
      name: d.name, label: d.label, aliases: [`${d.label}s`, ...d.parents],
      fields: d.fields.map((f) => ({ name: f.element, label: f.label, type: f.type, required: f.mandatory, readOnly: f.readOnly, ...(f.choices.length ? { values: f.choices.map((c) => c.label) } : {}), aliases: [f.element] })),
    });
  }
  return makeSnapshot('servicenow', objs, { source: o.source ?? client.instanceUrl, release: o.release });
}

interface Parsed { tag: string; action: string; fields: Record<string, string>; attrs: Record<string, string> }

function parsePayload(payload: string): Parsed[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(payload) as Record<string, unknown>;
  } catch {
    return [];
  }
  const ru = (doc.record_update ?? doc) as Record<string, unknown>;
  const out: Parsed[] = [];
  for (const [tag, v] of Object.entries(ru)) {
    if (tag.startsWith('@_') || tag === '?xml') continue;
    for (const node of Array.isArray(v) ? v : [v]) {
      if (!node || typeof node !== 'object') continue;
      const n = node as Record<string, unknown>;
      const fields: Record<string, string> = {};
      const attrs: Record<string, string> = {};
      for (const [k, x] of Object.entries(n)) {
        if (k.startsWith('@_')) attrs[k.slice(2)] = String(x);
        else if (x && typeof x === 'object') {
          fields[k] = String((x as Record<string, unknown>)['#text'] ?? '');
          const dv = (x as Record<string, unknown>)['@_display_value'];
          if (dv !== undefined) fields[`${k}@display`] = String(dv);
        } else fields[k] = String(x ?? '');
      }
      out.push({ tag, action: attrs.action ?? 'INSERT_OR_UPDATE', fields, attrs });
    }
  }
  return out;
}

export interface ServiceNowImpactOptions {
  /** Tables the journeys use (for inheritance: a change on task reaches incident). */
  tables: string[];
}

/** Turn an update set into AppChange records, compared with the live dictionary. */
export async function updateSetChanges(client: ServiceNowClient, updateSet: string, o: ServiceNowImpactOptions): Promise<AppChange[]> {
  const us = await client.updateSet(updateSet);
  const source = `update set "${us.name}"`;
  const out: AppChange[] = [];
  const describe = async (t: string): Promise<SnTable | undefined> => client.describe(t).catch(() => undefined);
  const names = async (table: string) => {
    const d = await describe(table);
    const kids = await client.childTables(table, o.tables).catch(() => [] as string[]);
    const kidMeta = await Promise.all(kids.map(describe));
    return [...new Set([table, ...(d ? [d.label] : []), ...kids, ...kidMeta.flatMap((k) => (k ? [k.label] : []))])];
  };
  for (const x of us.updates) out.push(...(await classify(x, source, names, describe, client)));
  return out;
}

async function classify(
  x: SnUpdateXml, source: string, names: (t: string) => Promise<string[]>, describe: (t: string) => Promise<SnTable | undefined>, client: ServiceNowClient,
): Promise<AppChange[]> {
  const out: AppChange[] = [];
  const base = async (table: string) => ({ pack: 'servicenow' as const, object: table, objectNames: await names(table), source });
  for (const p of parsePayload(x.payload)) {
    const f = p.fields;
    const del = p.action === 'DELETE';
    if (p.tag === 'sys_dictionary') {
      const table = f.name;
      const el = f.element;
      const cur = (await describe(table))?.fields.find((y) => y.element === el);
      const b = { ...(await base(table)), field: el, fieldNames: [el, f.column_label, cur?.label].filter((s): s is string => !!s) };
      if (del) out.push({ ...b, kind: 'field-removed', severity: 'breaking', detail: `${table}.${el} ("${cur?.label ?? f.column_label}") is deleted by ${source}` });
      else if (!cur) out.push({ ...b, kind: 'field-added', severity: f.mandatory === 'true' ? 'breaking' : 'review', detail: `${source} adds ${table}.${el} ("${f.column_label}", ${f.internal_type}${f.mandatory === 'true' ? ', mandatory' : ''})` });
      else {
        if (f.mandatory === 'true' && !cur.mandatory) out.push({ ...b, kind: 'field-required', severity: 'breaking', detail: `${source} makes ${table}.${el} ("${cur.label}") mandatory` });
        if (f.read_only === 'true' && !cur.readOnly) out.push({ ...b, kind: 'field-readonly', severity: 'breaking', detail: `${source} makes ${table}.${el} ("${cur.label}") read-only` });
        if (f.internal_type && f.internal_type !== cur.type) out.push({ ...b, kind: 'field-type-changed', severity: 'breaking', detail: `${source} changes ${table}.${el} type ${cur.type} -> ${f.internal_type}` });
        if (f.column_label && f.column_label !== cur.label) out.push({ ...b, kind: 'field-relabeled', severity: 'breaking', breakingNames: [cur.label], detail: `${source} relabels ${table}.${el} "${cur.label}" -> "${f.column_label}"` });
      }
    } else if (p.tag === 'sys_documentation') {
      const cur = (await describe(f.name))?.fields.find((y) => y.element === f.element);
      if (cur && f.label && f.label !== cur.label) {
        out.push({ ...(await base(f.name)), field: f.element, fieldNames: [f.element, cur.label, f.label], kind: 'field-relabeled', severity: 'breaking', breakingNames: [cur.label], detail: `${source} relabels ${f.name}.${f.element} "${cur.label}" -> "${f.label}"` });
      }
    } else if (p.tag === 'sys_choice') {
      const table = f.name || p.attrs.table;
      const el = f.element || p.attrs.field;
      const cur = (await describe(table))?.fields.find((y) => y.element === el);
      const b = { ...(await base(table)), field: el, fieldNames: [el, cur?.label].filter((s): s is string => !!s) };
      if (del) out.push({ ...b, kind: 'values-removed', values: [f.value, f.label].filter(Boolean), severity: 'breaking', detail: `${source} removes choice "${f.label || f.value}" from ${table}.${el}` });
      else out.push({ ...b, kind: 'values-added', values: [f.value, f.label].filter(Boolean), severity: 'review', detail: `${source} adds or changes choice "${f.label || f.value}" on ${table}.${el}` });
    } else if (p.tag === 'sys_ui_policy_action') {
      const table = f.table;
      const el = f.field;
      const cur = (await describe(table))?.fields.find((y) => y.element === el);
      const b = { ...(await base(table)), field: el, fieldNames: [el, cur?.label].filter((s): s is string => !!s) };
      if (f.mandatory === 'true') out.push({ ...b, kind: 'field-required', severity: 'breaking', detail: `${source}: a UI policy makes ${table}.${el} mandatory` });
      if (f.disabled === 'true') out.push({ ...b, kind: 'field-readonly', severity: 'breaking', detail: `${source}: a UI policy makes ${table}.${el} read-only` });
      if (f.visible === 'false') out.push({ ...b, kind: 'ui-changed', severity: 'breaking', detail: `${source}: a UI policy hides ${table}.${el}` });
    } else if (p.tag === 'sys_ui_action') {
      const table = f.table;
      const b = { ...(await base(table)), field: `ui_action:${f.action_name || f.name}`, fieldNames: [f.name, f.action_name].filter(Boolean) };
      if (del || f.active === 'false') out.push({ ...b, kind: 'ui-changed', severity: 'breaking', detail: `${source} ${del ? 'deletes' : 'deactivates'} the UI action "${f.name}" on ${table}` });
      else out.push({ ...b, kind: 'logic-changed', severity: 'review', detail: `${source} changes the UI action "${f.name}" on ${table}` });
    } else if (p.tag === 'sys_script' || p.tag === 'sys_script_client' || p.tag === 'sys_ui_policy' || p.tag === 'sys_data_policy2') {
      const table = f.collection || f.table || f.model_table;
      if (table) out.push({ ...(await base(table)), kind: 'logic-changed', severity: 'review', detail: `${source} ${del ? 'deletes' : 'changes'} ${p.tag === 'sys_script' ? 'business rule' : p.tag === 'sys_script_client' ? 'client script' : 'policy'} "${f.name || f.short_description}" on ${table}` });
    } else if (p.tag === 'sys_ui_section' || p.tag === 'sys_ui_form' || p.tag === 'sys_ui_element') {
      const table = f.name || f.table;
      if (table) out.push({ ...(await base(table)), kind: 'ui-changed', severity: 'review', detail: `${source} changes the ${table} form layout` });
    } else if (p.tag === 'sys_security_acl') {
      const [table, el] = (f.name || '').split('.');
      if (table) out.push({ ...(await base(table)), ...(el && el !== '*' ? { field: el, fieldNames: [el] } : {}), kind: 'security-changed', severity: 'review', detail: `${source} changes the ${f.operation || ''} ACL ${f.name}`.replace(/\s+/g, ' ') });
    } else if (p.tag === 'item_option_new') {
      const item = f['cat_item@display'] || f.cat_item;
      const b = { pack: 'servicenow' as const, object: `catalog:${item}`, objectNames: [item], field: f.name, fieldNames: [f.name, f.question_text].filter(Boolean), source };
      if (del) out.push({ ...b, kind: 'field-removed', severity: 'breaking', detail: `${source} deletes the variable "${f.question_text || f.name}" from catalog item "${item}"` });
      else out.push({ ...b, kind: f.mandatory === 'true' ? 'field-required' : 'field-added', severity: f.mandatory === 'true' ? 'breaking' : 'review', detail: `${source} adds or changes the variable "${f.question_text || f.name}" on "${item}"` });
    } else if (p.tag === 'sc_cat_item') {
      const b = { pack: 'servicenow' as const, object: `catalog:${f.name}`, objectNames: [f.name], source };
      if (del || f.active === 'false') out.push({ ...b, kind: 'object-removed', severity: 'breaking', detail: `${source} ${del ? 'deletes' : 'deactivates'} catalog item "${f.name}"` });
      else out.push({ ...b, kind: 'object-changed', severity: 'review', detail: `${source} changes catalog item "${f.name}"` });
    }
  }
  if (!out.length && x.name) {
    // Unclassified customer update: keep it visible as a review item if it names a table we know.
    const m = /^(?:sys_\w+?)_([a-z_]+?)_[a-z_0-9]+$/.exec(x.name);
    if (m && (await describe(m[1]))) out.push({ ...(await base(m[1])), kind: 'object-changed', severity: 'review', detail: `${source}: ${x.type} "${x.targetName}"` });
  }
  void client;
  return out;
}

/** Records a ServiceNow upgrade skipped (customised), as review items. */
export async function skippedUpgradeChanges(client: ServiceNowClient, o: ServiceNowImpactOptions & { upgrade?: string }): Promise<AppChange[]> {
  const rows: SnSkipped[] = await client.skippedRecords({ upgrade: o.upgrade });
  const out: AppChange[] = [];
  for (const r of rows) {
    const source = `upgrade skipped record (${r.upgrade || 'upgrade'})`;
    let table: string | undefined;
    let field: string | undefined;
    let fieldNames: string[] | undefined;
    const dict = /^sys_dictionary_(.+)$/.exec(r.fileName);
    const ua = /^sys_ui_action_([0-9a-f]{32})$/.exec(r.fileName);
    if (dict) {
      const [t, el] = r.targetName.includes('.') ? r.targetName.split('.') : [undefined, undefined];
      table = t;
      field = el;
      const cur = t ? (await client.describe(t).catch(() => undefined))?.fields.find((f) => f.element === el) : undefined;
      fieldNames = [el, cur?.label].filter((s): s is string => !!s);
    } else if (ua) {
      const a = await client.uiAction(ua[1]);
      if (a) {
        table = a.table;
        field = `ui_action:${a.actionName || a.name}`;
        fieldNames = [a.name, a.actionName].filter(Boolean);
      }
    }
    const kids = table ? await client.childTables(table, o.tables).catch(() => [] as string[]) : [];
    out.push({
      pack: 'servicenow', kind: 'skipped-upgrade', object: table ?? r.targetName, objectNames: table ? [table, ...kids] : [r.targetName],
      ...(field ? { field, fieldNames } : {}), severity: 'review', source,
      detail: `the upgrade skipped the customised ${r.type} "${r.targetName}" (${r.fileName}); the journey runs on your customisation, not the new baseline${r.resolution ? `, resolution: ${r.resolution}` : ''}`,
    });
  }
  return out;
}

/** What a ServiceNow step touches. */
export const serviceNowScoper: StepScoper = (step: Step, cur) => {
  const h = step.handler ?? '';
  const a = step.args ?? {};
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
  const texts = [step.intent, step.value ?? ''].filter(Boolean);
  const tableOf = (t?: string) => (t ? normalizeLabel(t).replace(/\s+/g, '_') : undefined);
  switch (h) {
    case 'sn.newRecord': {
      const t = s('table')!;
      return { carry: [t, tableOf(t)!], scope: { objects: [t, tableOf(t)!], fields: [], creates: tableOf(t), texts } };
    }
    case 'sn.openRecord':
    case 'sn.openList':
    case 'sn.expectList': {
      const t = s('table')!;
      return { carry: [t, tableOf(t)!], scope: { objects: [t, tableOf(t)!], fields: [], texts } };
    }
    case 'sn.openCatalogItem': {
      const i = s('item')!;
      return { carry: [i, `catalog:${i}`], scope: { objects: [i, `catalog:${i}`], fields: [], creates: `catalog:${i}`, texts } };
    }
    case 'sn.setField':
    case 'sn.expectField':
    case 'sn.expectFieldState':
      return { scope: { objects: cur.objects, fields: [{ ref: s('field')!, ...(s('value') !== undefined ? { value: s('value') } : {}) }], texts } };
    case 'sn.uiAction':
    case 'sn.expectUiAction':
      return { scope: { objects: cur.objects, fields: [{ ref: s('action')! }], texts } };
    case 'sn.verifyRecord': {
      const t = s('table')!;
      const fields = Object.entries((a.expect as Record<string, unknown>) ?? {}).map(([ref, v]) => ({ ref, value: String(v) }));
      return { scope: { objects: [t, tableOf(t)!], fields, texts } };
    }
    case 'sn.orderCatalogItem':
    case 'sn.expectMessage':
    case 'sn.expectRelatedList':
      return { scope: { objects: cur.objects, fields: [], texts } };
    default:
      return {};
  }
};
