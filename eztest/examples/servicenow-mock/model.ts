/**
 * Data model for the ServiceNow mock: dictionary (tables with inheritance,
 * fields, choices, references), records, users/roles with simple ACLs, the
 * service catalog (items + variables), update sets with sys_update_xml
 * payloads and upgrade history (skipped records). Shapes follow the public
 * Table API and the platform tables' documented columns; this is an emulation
 * for tests, not ServiceNow.
 */
import { randomBytes } from 'node:crypto';

export type FieldType = 'string' | 'integer' | 'boolean' | 'reference' | 'glide_date_time' | 'journal_input' | 'sys_id';
export type Rec = Record<string, string>;

export interface MockChoice { value: string; label: string; inactive?: boolean }

export interface MockField {
  table: string;
  element: string;
  label: string;
  type: FieldType;
  mandatory?: boolean;
  readOnly?: boolean;
  reference?: string;
  maxLength?: number;
  /** 0 = no choice list, 1 = dropdown with -- None --, 3 = dropdown without none. */
  choice?: 0 | 1 | 3;
  choices?: MockChoice[];
  /** Shown on the default form. */
  onForm?: boolean;
}

export interface MockTable { name: string; label: string; parent?: string; numberPrefix?: string; displayField: string }

export const TABLES: MockTable[] = [
  { name: 'task', label: 'Task', displayField: 'number', numberPrefix: 'TASK' },
  { name: 'incident', label: 'Incident', parent: 'task', displayField: 'number', numberPrefix: 'INC' },
  { name: 'change_request', label: 'Change Request', parent: 'task', displayField: 'number', numberPrefix: 'CHG' },
  { name: 'sc_request', label: 'Request', parent: 'task', displayField: 'number', numberPrefix: 'REQ' },
  { name: 'sc_req_item', label: 'Requested Item', parent: 'task', displayField: 'number', numberPrefix: 'RITM' },
  { name: 'task_sla', label: 'Task SLA', displayField: 'sla' },
  { name: 'sys_user', label: 'User', displayField: 'name' },
  { name: 'sys_user_group', label: 'Group', displayField: 'name' },
  { name: 'sc_cat_item', label: 'Catalog Item', displayField: 'name' },
  { name: 'item_option_new', label: 'Variable', displayField: 'question_text' },
  { name: 'question_choice', label: 'Question Choice', displayField: 'text' },
  { name: 'sys_ui_action', label: 'UI Action', displayField: 'name' },
  { name: 'sys_update_set', label: 'Update Set', displayField: 'name' },
  { name: 'sys_update_xml', label: 'Customer Update', displayField: 'name' },
  { name: 'sys_upgrade_history_log', label: 'Upgrade Log', displayField: 'file_name' },
];

const STATE: MockChoice[] = [
  { value: '1', label: 'New' }, { value: '2', label: 'In Progress' }, { value: '3', label: 'On Hold' }, { value: '6', label: 'Resolved' }, { value: '7', label: 'Closed' }, { value: '8', label: 'Canceled' },
];
const PRIORITY: MockChoice[] = [
  { value: '1', label: '1 - Critical' }, { value: '2', label: '2 - High' }, { value: '3', label: '3 - Moderate' }, { value: '4', label: '4 - Low' }, { value: '5', label: '5 - Planning' },
];
const CATEGORY: MockChoice[] = [
  { value: 'inquiry', label: 'Inquiry / Help' }, { value: 'software', label: 'Software' }, { value: 'hardware', label: 'Hardware' }, { value: 'network', label: 'Network' }, { value: 'database', label: 'Database' },
];
const CLOSE_CODE: MockChoice[] = [
  { value: 'Solved (Permanently)', label: 'Solved (Permanently)' }, { value: 'Solved (Work Around)', label: 'Solved (Work Around)' }, { value: 'Not Solved (Not Reproducible)', label: 'Not Solved (Not Reproducible)' },
];
const CHG_TYPE: MockChoice[] = [{ value: 'normal', label: 'Normal' }, { value: 'standard', label: 'Standard' }, { value: 'emergency', label: 'Emergency' }];

export function baseFields(): MockField[] {
  const f = (table: string, element: string, label: string, type: FieldType, o: Partial<MockField> = {}): MockField => ({ table, element, label, type, ...o });
  return [
    f('task', 'sys_id', 'Sys ID', 'sys_id', { readOnly: true }),
    f('task', 'number', 'Number', 'string', { readOnly: true, onForm: true, maxLength: 40 }),
    f('task', 'short_description', 'Short description', 'string', { onForm: true, maxLength: 160 }),
    f('task', 'description', 'Description', 'string', { onForm: true, maxLength: 4000 }),
    f('task', 'priority', 'Priority', 'integer', { choice: 1, choices: PRIORITY, onForm: true }),
    f('task', 'state', 'State', 'integer', { choice: 3, choices: STATE, onForm: true }),
    f('task', 'assignment_group', 'Assignment group', 'reference', { reference: 'sys_user_group', onForm: true }),
    f('task', 'assigned_to', 'Assigned to', 'reference', { reference: 'sys_user', onForm: true }),
    f('task', 'active', 'Active', 'boolean', { readOnly: true }),
    f('task', 'opened_at', 'Opened', 'glide_date_time', { readOnly: true }),
    f('task', 'work_notes', 'Work notes', 'journal_input', { onForm: true }),
    f('incident', 'caller_id', 'Caller', 'reference', { reference: 'sys_user', mandatory: true, onForm: true }),
    f('incident', 'category', 'Category', 'string', { choice: 1, choices: CATEGORY, onForm: true }),
    f('incident', 'close_code', 'Resolution code', 'string', { choice: 1, choices: CLOSE_CODE, onForm: true }),
    f('incident', 'close_notes', 'Resolution notes', 'string', { maxLength: 4000, onForm: true }),
    f('incident', 'u_internal_cost', 'Internal cost', 'integer', { onForm: true }),
    f('change_request', 'type', 'Type', 'string', { choice: 3, choices: CHG_TYPE, onForm: true }),
    f('change_request', 'justification', 'Justification', 'string', { maxLength: 4000, onForm: true }),
    f('sc_request', 'requested_for', 'Requested for', 'reference', { reference: 'sys_user', onForm: true }),
    f('sc_req_item', 'request', 'Request', 'reference', { reference: 'sc_request', onForm: true }),
    f('sc_req_item', 'cat_item', 'Item', 'reference', { reference: 'sc_cat_item', onForm: true }),
    f('task_sla', 'task', 'Task', 'reference', { reference: 'task' }),
    f('task_sla', 'sla', 'SLA definition', 'string'),
    f('task_sla', 'stage', 'Stage', 'string'),
    f('task_sla', 'has_breached', 'Has breached', 'boolean'),
    f('sys_user', 'user_name', 'User ID', 'string'),
    f('sys_user', 'name', 'Name', 'string'),
    f('sys_user', 'email', 'Email', 'string'),
    f('sys_user_group', 'name', 'Name', 'string'),
    f('sc_cat_item', 'name', 'Name', 'string'),
    f('sc_cat_item', 'short_description', 'Short description', 'string'),
    f('sc_cat_item', 'active', 'Active', 'boolean'),
    f('item_option_new', 'cat_item', 'Catalog item', 'reference', { reference: 'sc_cat_item' }),
    f('item_option_new', 'name', 'Name', 'string'),
    f('item_option_new', 'question_text', 'Question', 'string'),
    f('item_option_new', 'type', 'Type', 'integer'),
    f('item_option_new', 'mandatory', 'Mandatory', 'boolean'),
    f('item_option_new', 'order', 'Order', 'integer'),
    f('question_choice', 'question', 'Question', 'reference', { reference: 'item_option_new' }),
    f('question_choice', 'value', 'Value', 'string'),
    f('question_choice', 'text', 'Text', 'string'),
    f('sys_ui_action', 'name', 'Name', 'string'),
    f('sys_ui_action', 'table', 'Table', 'string'),
    f('sys_ui_action', 'action_name', 'Action name', 'string'),
    f('sys_ui_action', 'active', 'Active', 'boolean'),
    f('sys_update_set', 'name', 'Name', 'string'),
    f('sys_update_set', 'state', 'State', 'string'),
    f('sys_update_set', 'application', 'Application', 'string'),
    f('sys_update_xml', 'name', 'Name', 'string'),
    f('sys_update_xml', 'type', 'Type', 'string'),
    f('sys_update_xml', 'target_name', 'Target name', 'string'),
    f('sys_update_xml', 'action', 'Action', 'string'),
    f('sys_update_xml', 'update_set', 'Update set', 'reference', { reference: 'sys_update_set' }),
    f('sys_update_xml', 'payload', 'Payload', 'string', { maxLength: 65000 }),
    f('sys_upgrade_history_log', 'file_name', 'File name', 'string'),
    f('sys_upgrade_history_log', 'type', 'Type', 'string'),
    f('sys_upgrade_history_log', 'target_name', 'Target name', 'string'),
    f('sys_upgrade_history_log', 'disposition', 'Disposition', 'integer', { choice: 3, choices: [{ value: '1', label: 'Inserted' }, { value: '2', label: 'Updated' }, { value: '4', label: 'Skipped' }, { value: '9', label: 'Skipped Error' }] }),
    f('sys_upgrade_history_log', 'resolution_status', 'Resolution status', 'string'),
    f('sys_upgrade_history_log', 'upgrade_history', 'Upgrade', 'string'),
  ];
}

/** Catalog variable types (item_option_new.type). */
export const VAR_TYPE = { singleLine: '6', multiLine: '2', selectBox: '5', checkbox: '7' } as const;

export interface MockUser { sysId: string; userName: string; name: string; password: string; roles: string[] }

export type Access = 'write' | 'read' | 'none';

/** Table and field ACLs (a much simplified emulation of ServiceNow ACL evaluation). */
export function tableAccess(u: MockUser, table: string): Access {
  if (u.roles.includes('admin')) return 'write';
  const itil = u.roles.includes('itil');
  if (['incident', 'task_sla', 'sys_user', 'sys_user_group'].includes(table)) return itil ? 'write' : 'read';
  if (table === 'change_request') return itil ? 'read' : 'none';
  if (['sc_cat_item', 'item_option_new', 'question_choice', 'sc_request', 'sc_req_item'].includes(table)) return itil ? 'write' : 'read';
  return 'none';
}

export function fieldAccess(u: MockUser, f: MockField, table: string): Access {
  const t = tableAccess(u, table);
  if (t === 'none') return 'none';
  if (f.element === 'u_internal_cost' && !u.roles.includes('admin')) return u.roles.includes('itil') ? 'read' : 'none';
  if (f.element === 'work_notes' && !u.roles.includes('itil') && !u.roles.includes('admin')) return 'none';
  if (f.readOnly || f.type === 'sys_id') return 'read';
  return t;
}

export class Store {
  readonly tables = new Map<string, Map<string, Rec>>();
  private counters = new Map<string, number>();
  constructor() {
    for (const t of TABLES) this.tables.set(t.name, new Map());
  }
  table(name: string): Map<string, Rec> {
    const t = this.tables.get(name);
    if (!t) throw new Error(`no table ${name}`);
    return t;
  }
  newId(): string {
    return randomBytes(16).toString('hex');
  }
  insert(table: string, data: Rec, prefix?: string): Rec {
    const id = data.sys_id || this.newId();
    const rec: Rec = { sys_id: id, sys_created_on: '2026-10-01 09:00:00', sys_updated_on: '2026-10-01 09:00:00', ...data };
    if (prefix && !rec.number) {
      const n = (this.counters.get(prefix) ?? 10000) + 1;
      this.counters.set(prefix, n);
      rec.number = `${prefix}${String(n).padStart(7, '0')}`;
    }
    this.table(table).set(id, rec);
    return rec;
  }
  find(table: string, pred: (r: Rec) => boolean): Rec[] {
    return [...this.table(table).values()].filter(pred);
  }
}

export function genPassword(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}
