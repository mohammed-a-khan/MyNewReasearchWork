/**
 * sObject metadata, profiles / field-level security, validation rules and an
 * in-memory record store for the Salesforce Lightning mock.
 *
 * Describe shapes follow the REST API (`/sobjects/{obj}/describe`): field
 * name, label, type, nillable, createable, updateable, picklistValues (with
 * base64 `validFor` bitsets for dependent picklists), referenceTo and
 * relationshipName. A "release" switch (Spring -> Summer -> Winter, cumulative)
 * relabels a field, adds a required field and changes picklist value sets.
 */

export type SfFieldType =
  | 'id' | 'string' | 'textarea' | 'picklist' | 'currency' | 'date' | 'datetime' | 'boolean' | 'reference'
  | 'phone' | 'email' | 'double' | 'int' | 'percent' | 'url';

export type Release = 'Spring' | 'Summer' | 'Winter';
export const RELEASES: Release[] = ['Spring', 'Summer', 'Winter'];

export interface MockPicklistValue {
  value: string;
  label: string;
  /** Controller values this dependent value is valid for. */
  validFor?: string[];
  defaultValue?: boolean;
}

export interface MockField {
  name: string;
  label: string;
  type: SfFieldType;
  /** nillable=false (and createable): a required field. */
  required?: boolean;
  /** System fields (Id, CaseNumber, Contact.Name) cannot be written by anyone. */
  system?: boolean;
  picklist?: MockPicklistValue[];
  controllerName?: string;
  referenceTo?: string[];
  relationshipName?: string;
  length?: number;
  nameField?: boolean;
  custom?: boolean;
}

export interface MockRelatedList {
  /** Related list label, e.g. "Contacts". */
  label: string;
  childObject: string;
  field: string;
  relationshipName: string;
  columns: string[];
}

export interface MockObject {
  name: string;
  label: string;
  labelPlural: string;
  keyPrefix: string;
  fields: MockField[];
  listColumns: string[];
  highlights: string[];
  related: MockRelatedList[];
  /** Picklist field rendered as a Lightning path. */
  pathField?: string;
}

const pl = (values: string[], extra: Record<string, string[]> = {}): MockPicklistValue[] =>
  values.map((v) => ({ value: v, label: v, ...(extra[v] ? { validFor: extra[v] } : {}) }));

function baseObjects(): MockObject[] {
  const account: MockObject = {
    name: 'Account', label: 'Account', labelPlural: 'Accounts', keyPrefix: '001',
    fields: [
      { name: 'Id', label: 'Account ID', type: 'id', system: true },
      { name: 'Name', label: 'Account Name', type: 'string', required: true, length: 255, nameField: true },
      { name: 'Type', label: 'Type', type: 'picklist', picklist: pl(['Prospect', 'Customer - Direct', 'Customer - Channel', 'Partner']) },
      { name: 'Industry', label: 'Industry', type: 'picklist', picklist: pl(['Agriculture', 'Banking', 'Energy', 'Retail', 'Technology']) },
      {
        name: 'Sub_Industry__c', label: 'Sub-Industry', type: 'picklist', custom: true, controllerName: 'Industry',
        picklist: [
          { value: 'Retail Banking', label: 'Retail Banking', validFor: ['Banking'] },
          { value: 'Investment Banking', label: 'Investment Banking', validFor: ['Banking'] },
          { value: 'Oil & Gas', label: 'Oil & Gas', validFor: ['Energy'] },
          { value: 'Renewables', label: 'Renewables', validFor: ['Energy'] },
          { value: 'Utilities', label: 'Utilities', validFor: ['Energy'] },
          { value: 'Software', label: 'Software', validFor: ['Technology'] },
          { value: 'Hardware', label: 'Hardware', validFor: ['Technology'] },
          { value: 'Grocery', label: 'Grocery', validFor: ['Retail'] },
        ],
      },
      { name: 'Phone', label: 'Account Phone', type: 'phone', length: 40 },
      { name: 'AnnualRevenue', label: 'Annual Revenue', type: 'currency' },
      { name: 'NumberOfEmployees', label: 'Employees', type: 'int' },
      { name: 'Active__c', label: 'Active', type: 'boolean', custom: true },
      { name: 'SLAExpirationDate__c', label: 'SLA Expiration Date', type: 'date', custom: true },
      { name: 'ParentId', label: 'Parent Account', type: 'reference', referenceTo: ['Account'], relationshipName: 'Parent' },
      { name: 'Description', label: 'Description', type: 'textarea', length: 32000 },
    ],
    listColumns: ['Name', 'Phone', 'Industry', 'Type'],
    highlights: ['Type', 'Phone', 'Industry'],
    related: [
      { label: 'Contacts', childObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts', columns: ['Name', 'Title', 'Email'] },
      { label: 'Opportunities', childObject: 'Opportunity', field: 'AccountId', relationshipName: 'Opportunities', columns: ['Name', 'StageName', 'CloseDate'] },
      { label: 'Cases', childObject: 'Case', field: 'AccountId', relationshipName: 'Cases', columns: ['CaseNumber', 'Subject', 'Status'] },
    ],
  };
  const contact: MockObject = {
    name: 'Contact', label: 'Contact', labelPlural: 'Contacts', keyPrefix: '003',
    fields: [
      { name: 'Id', label: 'Contact ID', type: 'id', system: true },
      { name: 'Name', label: 'Full Name', type: 'string', system: true, nameField: true },
      { name: 'FirstName', label: 'First Name', type: 'string', length: 40 },
      { name: 'LastName', label: 'Last Name', type: 'string', required: true, length: 80 },
      { name: 'Title', label: 'Title', type: 'string', length: 128 },
      { name: 'Email', label: 'Email', type: 'email', length: 80 },
      { name: 'Phone', label: 'Phone', type: 'phone', length: 40 },
      { name: 'AccountId', label: 'Account Name', type: 'reference', referenceTo: ['Account'], relationshipName: 'Account' },
    ],
    listColumns: ['Name', 'Title', 'Email'],
    highlights: ['Title', 'Email', 'Phone'],
    related: [],
  };
  const opportunity: MockObject = {
    name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', keyPrefix: '006',
    fields: [
      { name: 'Id', label: 'Opportunity ID', type: 'id', system: true },
      { name: 'Name', label: 'Opportunity Name', type: 'string', required: true, length: 120, nameField: true },
      { name: 'AccountId', label: 'Account Name', type: 'reference', referenceTo: ['Account'], relationshipName: 'Account' },
      { name: 'Amount', label: 'Amount', type: 'currency' },
      { name: 'CloseDate', label: 'Close Date', type: 'date', required: true },
      { name: 'StageName', label: 'Stage', type: 'picklist', required: true, picklist: pl(['Prospecting', 'Qualification', 'Needs Analysis', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost']) },
      { name: 'Probability', label: 'Probability (%)', type: 'percent' },
      { name: 'Description', label: 'Description', type: 'textarea', length: 32000 },
    ],
    listColumns: ['Name', 'AccountId', 'StageName', 'CloseDate'],
    highlights: ['AccountId', 'CloseDate', 'Amount'],
    related: [],
    pathField: 'StageName',
  };
  const kase: MockObject = {
    name: 'Case', label: 'Case', labelPlural: 'Cases', keyPrefix: '500',
    fields: [
      { name: 'Id', label: 'Case ID', type: 'id', system: true },
      { name: 'CaseNumber', label: 'Case Number', type: 'string', system: true, nameField: true },
      { name: 'Subject', label: 'Subject', type: 'string', length: 255 },
      { name: 'Status', label: 'Status', type: 'picklist', required: true, picklist: pl(['New', 'Working', 'Escalated', 'Closed']) },
      { name: 'Priority', label: 'Priority', type: 'picklist', picklist: pl(['High', 'Medium', 'Low']) },
      { name: 'AccountId', label: 'Account Name', type: 'reference', referenceTo: ['Account'], relationshipName: 'Account' },
      { name: 'Description', label: 'Description', type: 'textarea', length: 32000 },
    ],
    listColumns: ['CaseNumber', 'Subject', 'Status', 'Priority'],
    highlights: ['Status', 'Priority'],
    related: [],
  };
  return [account, contact, opportunity, kase];
}

/**
 * Object metadata for a release. Changes are cumulative:
 *  - Summer: Account.Phone "Account Phone" -> "Main Phone"; new required Account.Region__c;
 *    Industry loses "Banking" and gains "Financial Services" (Sub-Industry follows).
 *  - Winter: Opportunity.StageName loses "Needs Analysis" and gains "Discovery";
 *    Opportunity.Amount is relabelled "Opportunity Amount".
 */
export function objectsFor(release: Release): MockObject[] {
  const objs = baseObjects();
  const level = RELEASES.indexOf(release);
  const field = (o: string, f: string) => objs.find((x) => x.name === o)!.fields.find((x) => x.name === f)!;
  if (level >= 1) {
    field('Account', 'Phone').label = 'Main Phone';
    const acc = objs.find((x) => x.name === 'Account')!;
    acc.fields.splice(3, 0, { name: 'Region__c', label: 'Region', type: 'picklist', required: true, custom: true, picklist: pl(['AMER', 'EMEA', 'APAC']) });
    const ind = field('Account', 'Industry');
    ind.picklist = pl(['Agriculture', 'Energy', 'Financial Services', 'Retail', 'Technology']);
    for (const v of field('Account', 'Sub_Industry__c').picklist ?? []) {
      if (v.validFor?.includes('Banking')) v.validFor = ['Financial Services'];
    }
  }
  if (level >= 2) {
    const stage = field('Opportunity', 'StageName');
    stage.picklist = pl(['Prospecting', 'Qualification', 'Discovery', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost']);
    field('Opportunity', 'Amount').label = 'Opportunity Amount';
  }
  return objs;
}

// ------------------------------------------------------------------ profiles

export type FieldAccess = 'edit' | 'read' | 'hidden';

export interface MockProfile {
  name: string;
  /** Object permissions; objects not listed are inaccessible. */
  objects: Record<string, { read: boolean; create: boolean; edit: boolean; delete: boolean }>;
  /** Field-level security overrides, keyed "Object.Field"; default edit. */
  fls: Record<string, FieldAccess>;
  /** Tabs (object API names) visible to the profile. */
  tabs: string[];
}

const ALL = { read: true, create: true, edit: true, delete: true };

export const PROFILES: Record<string, MockProfile> = {
  'System Administrator': {
    name: 'System Administrator',
    objects: { Account: ALL, Contact: ALL, Opportunity: ALL, Case: ALL },
    fls: {},
    tabs: ['Account', 'Contact', 'Opportunity', 'Case'],
  },
  'Sales Rep': {
    name: 'Sales Rep',
    objects: {
      Account: { read: true, create: true, edit: true, delete: false },
      Contact: { read: true, create: true, edit: true, delete: false },
      Opportunity: { read: true, create: true, edit: true, delete: false },
    },
    fls: { 'Account.AnnualRevenue': 'read', 'Account.NumberOfEmployees': 'hidden' },
    tabs: ['Account', 'Contact', 'Opportunity'],
  },
};

export interface MockUser {
  id: string;
  username: string;
  name: string;
  profile: string;
  password: string;
}

/** Effective access of a user to a field ('hidden' when the object is inaccessible). */
export function fieldAccess(profile: MockProfile, obj: MockObject, f: MockField): FieldAccess {
  const op = profile.objects[obj.name];
  if (!op?.read) return 'hidden';
  const fls = profile.fls[`${obj.name}.${f.name}`] ?? 'edit';
  if (fls === 'hidden') return 'hidden';
  if (f.system || f.type === 'id') return 'read';
  if (!op.edit && !op.create) return 'read';
  return fls;
}

// ------------------------------------------------------------------ ids

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SUFFIX = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

/** 15-char id -> 18-char case-insensitive id (Salesforce checksum suffix). */
export function to18(id15: string): string {
  let suffix = '';
  for (let i = 0; i < 3; i++) {
    let flags = 0;
    for (let j = 0; j < 5; j++) {
      const c = id15.charAt(i * 5 + j);
      if (c >= 'A' && c <= 'Z') flags += 1 << j;
    }
    suffix += SUFFIX.charAt(flags);
  }
  return id15 + suffix;
}

// ------------------------------------------------------------------ store

export type Value = string | number | boolean | null;
export type MockRecord = Record<string, Value>;

export class MockStore {
  private readonly tables = new Map<string, Map<string, MockRecord>>();
  private seq = 0;
  private caseSeq = 1000;

  table(obj: string): Map<string, MockRecord> {
    let t = this.tables.get(obj);
    if (!t) {
      t = new Map();
      this.tables.set(obj, t);
    }
    return t;
  }

  newId(prefix: string): string {
    let n = ++this.seq;
    let s = '';
    for (let i = 0; i < 7; i++) {
      s = B62.charAt(n % 62) + s;
      n = Math.floor(n / 62);
    }
    return to18(`${prefix}5g000${s}`);
  }

  insert(obj: MockObject, values: MockRecord): string {
    const id = this.newId(obj.keyPrefix);
    const rec: MockRecord = { Id: id };
    for (const f of obj.fields) if (f.name !== 'Id') rec[f.name] = null;
    Object.assign(rec, values);
    if (obj.name === 'Case') rec.CaseNumber = String(++this.caseSeq).padStart(8, '0');
    if (obj.name === 'Contact') rec.Name = [rec.FirstName, rec.LastName].filter((x) => x).join(' ');
    const now = new Date().toISOString();
    rec.CreatedDate = now;
    rec.LastModifiedDate = now;
    this.table(obj.name).set(id, rec);
    return id;
  }

  update(obj: MockObject, id: string, values: MockRecord): boolean {
    const rec = this.table(obj.name).get(id);
    if (!rec) return false;
    Object.assign(rec, values);
    if (obj.name === 'Contact') rec.Name = [rec.FirstName, rec.LastName].filter((x) => x).join(' ');
    rec.LastModifiedDate = new Date().toISOString();
    return true;
  }

  /** Find a record by an 15- or 18-char id (case-insensitive suffix handling kept simple). */
  get(obj: string, id: string): MockRecord | undefined {
    const t = this.table(obj);
    if (id.length === 15) return [...t.values()].find((r) => String(r.Id).startsWith(id));
    return t.get(id);
  }

  findObjectOfId(objects: MockObject[], id: string): MockObject | undefined {
    return objects.find((o) => id.startsWith(o.keyPrefix) && this.get(o.name, id));
  }
}

export function nameFieldOf(obj: MockObject): MockField {
  return obj.fields.find((f) => f.nameField)!;
}

/** Display name of a record (its name field). */
export function recordName(obj: MockObject, rec: MockRecord): string {
  return String(rec[nameFieldOf(obj).name] ?? '');
}

/** Seed data used by the tests and the standalone server. */
export function seed(store: MockStore, objects: MockObject[]): void {
  const o = (n: string) => objects.find((x) => x.name === n)!;
  const globex = store.insert(o('Account'), {
    Name: 'Globex', Type: 'Customer - Direct', Industry: 'Technology', Sub_Industry__c: 'Software', Phone: '555-0101', AnnualRevenue: 5_000_000,
    NumberOfEmployees: 1200, Active__c: true,
  });
  store.insert(o('Account'), { Name: 'Acme Holdings', Type: 'Partner', Industry: 'Retail', Phone: '555-0102' });
  store.insert(o('Account'), { Name: 'Initech', Type: 'Prospect', Industry: 'Agriculture', Phone: '555-0103' });
  store.insert(o('Contact'), { FirstName: 'Jane', LastName: 'Doe', Title: 'CTO', Email: 'jane.doe@globex.test', AccountId: globex });
  store.insert(o('Contact'), { FirstName: 'John', LastName: 'Smith', Title: 'Buyer', Email: 'john.smith@globex.test', AccountId: globex });
  store.insert(o('Opportunity'), { Name: 'Globex Renewal', AccountId: globex, StageName: 'Qualification', CloseDate: '2030-06-30', Amount: 250_000 });
  store.insert(o('Case'), { Subject: 'Login issue', Status: 'New', Priority: 'High', AccountId: globex });
}

// ------------------------------------------------------------------ validation

export interface SfError {
  errorCode: string;
  message: string;
  fields: string[];
}

export const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** Validation rules evaluated on the merged record (after required/type checks). */
export function validationRules(obj: MockObject, rec: MockRecord): SfError[] {
  const out: SfError[] = [];
  if (obj.name === 'Opportunity') {
    const closed = typeof rec.StageName === 'string' && rec.StageName.startsWith('Closed');
    if (!closed && typeof rec.CloseDate === 'string' && rec.CloseDate <= todayIso()) {
      out.push({ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Close Date must be in the future for open opportunities', fields: ['CloseDate'] });
    }
  }
  return out;
}

/** Base64 `validFor` bitset: bit i (MSB first per byte) = valid for controller value i. */
export function encodeValidFor(controllerValues: string[], validFor: string[]): string {
  const bytes = new Uint8Array(Math.max(1, Math.ceil(controllerValues.length / 8)) + 2);
  controllerValues.forEach((v, i) => {
    if (validFor.includes(v)) bytes[i >> 3] |= 0x80 >> (i & 7);
  });
  return Buffer.from(bytes).toString('base64');
}
