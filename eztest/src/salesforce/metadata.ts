/**
 * Salesforce describe metadata used by the adapter: sObjects and their fields
 * (API name, label, type, required-ness, FLS-derived createable/updateable,
 * picklist values incl. dependent `validFor`, reference targets). A
 * DescribeSource is either the live SalesforceClient or a static snapshot.
 */
import { EzTestError } from '../core/index.js';

export interface PicklistValueMeta {
  value: string;
  label: string;
  active: boolean;
  defaultValue?: boolean;
  /** Decoded controller values this value is valid for (dependent picklists). */
  validFor?: string[];
}

export interface FieldMeta {
  name: string;
  label: string;
  /** Salesforce field type: string, textarea, picklist, multipicklist, currency, date, datetime, boolean, reference, id, ... */
  type: string;
  nillable: boolean;
  /** Writable on create / update for the describing user (field-level security). */
  createable: boolean;
  updateable: boolean;
  /** Must be given on create: !nillable && !defaultedOnCreate && not calculated/id. */
  required: boolean;
  calculated?: boolean;
  nameField?: boolean;
  custom?: boolean;
  length?: number;
  picklistValues?: PicklistValueMeta[];
  controllerName?: string;
  referenceTo?: string[];
  relationshipName?: string;
}

export interface SObjectMeta {
  name: string;
  label: string;
  labelPlural: string;
  keyPrefix?: string;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
  queryable: boolean;
}

export interface SObjectDescribe extends SObjectMeta {
  fields: FieldMeta[];
}

export interface DescribeSource {
  /** sObjects visible to the user (describeGlobal). */
  describeGlobal(): Promise<SObjectMeta[]>;
  describe(objectName: string): Promise<SObjectDescribe>;
}

/** A describe snapshot (also the JSON written by snapshotDescribe). */
export interface DescribeSnapshot {
  schema: 'eztest.salesforce.describe/v1';
  takenAt: string;
  source?: string;
  release?: string;
  objects: Record<string, SObjectDescribe>;
}

export class SalesforceMetadataError extends EzTestError {
  constructor(message: string, code = 'SF_METADATA', details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'SalesforceMetadataError';
  }
}

/** Salesforce API name: letter first, letters/digits/underscores, no trailing or tripled underscores (Name, Sub_Industry__c, ns__Obj__c). */
const API_NAME = /^[A-Za-z](?:[A-Za-z0-9]|_(?!__))*$/;

/** Validate an API name before it goes into a URL or a SOQL statement. */
export function assertApiName(name: string, what = 'API name'): string {
  if (typeof name !== 'string' || name.length > 80 || !API_NAME.test(name) || name.endsWith('_')) {
    throw new SalesforceMetadataError(`Invalid ${what} "${String(name)}"`, 'SF_BAD_NAME');
  }
  return name;
}

/** Validate a dotted field path (Name, Account.Name, Owner.Profile.Name). */
export function assertFieldPath(path: string, what = 'field'): string[] {
  if (typeof path !== 'string' || !path) throw new SalesforceMetadataError(`Invalid ${what} ""`, 'SF_BAD_NAME');
  const parts = path.split('.');
  if (parts.length > 5) throw new SalesforceMetadataError(`Invalid ${what} "${path}" (too many relationship levels)`, 'SF_BAD_NAME');
  for (const p of parts) assertApiName(p, what);
  return parts;
}

/** Decode a describe `validFor` bitset into the controller values it allows. */
export function decodeValidFor(b64: string, controllerValues: string[]): string[] {
  const bytes = Buffer.from(b64, 'base64');
  return controllerValues.filter((_, i) => (i >> 3) < bytes.length && (bytes[i >> 3] & (0x80 >> (i & 7))) !== 0);
}

const bool = (v: unknown) => v === true;
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Parse REST describe JSON (`/sobjects/{obj}/describe`) into SObjectDescribe. */
export function parseDescribe(j: Record<string, unknown>): SObjectDescribe {
  const name = str(j.name);
  if (!name || !Array.isArray(j.fields)) throw new SalesforceMetadataError('Describe response has no name/fields', 'SF_BAD_METADATA');
  const raw = j.fields as Array<Record<string, unknown>>;
  const byName = new Map(raw.map((f) => [String(f.name), f]));
  const fields: FieldMeta[] = raw.map((f) => {
    const fname = str(f.name);
    const type = str(f.type);
    if (!fname || !type) throw new SalesforceMetadataError(`Describe of ${name} has a field without name/type`, 'SF_BAD_METADATA');
    const calculated = bool(f.calculated) || bool(f.autoNumber);
    const nillable = f.nillable !== false;
    const out: FieldMeta = {
      name: fname,
      label: str(f.label) ?? fname,
      type,
      nillable,
      createable: bool(f.createable),
      updateable: bool(f.updateable),
      required: !nillable && !bool(f.defaultedOnCreate) && !calculated && type !== 'id',
    };
    if (calculated) out.calculated = true;
    if (bool(f.nameField)) out.nameField = true;
    if (bool(f.custom)) out.custom = true;
    if (typeof f.length === 'number' && f.length > 0) out.length = f.length;
    const controller = str(f.controllerName);
    if (controller) out.controllerName = controller;
    if (Array.isArray(f.picklistValues) && (f.picklistValues as unknown[]).length) {
      const ctl = controller ? byName.get(controller) : undefined;
      const ctlValues = ctl
        ? ctl.type === 'boolean'
          ? ['false', 'true']
          : ((ctl.picklistValues as Array<Record<string, unknown>> | undefined) ?? []).map((p) => String(p.value))
        : [];
      out.picklistValues = (f.picklistValues as Array<Record<string, unknown>>).map((p) => {
        const v: PicklistValueMeta = { value: String(p.value), label: str(p.label) ?? String(p.value), active: p.active !== false };
        if (bool(p.defaultValue)) v.defaultValue = true;
        if (controller && typeof p.validFor === 'string') v.validFor = decodeValidFor(p.validFor, ctlValues);
        return v;
      });
    }
    if (Array.isArray(f.referenceTo) && (f.referenceTo as unknown[]).length) out.referenceTo = (f.referenceTo as unknown[]).map(String);
    const rel = str(f.relationshipName);
    if (rel) out.relationshipName = rel;
    return out;
  });
  return {
    name,
    label: str(j.label) ?? name,
    labelPlural: str(j.labelPlural) ?? str(j.label) ?? name,
    ...(str(j.keyPrefix) ? { keyPrefix: str(j.keyPrefix) } : {}),
    createable: bool(j.createable),
    updateable: bool(j.updateable),
    deletable: bool(j.deletable),
    queryable: j.queryable !== false,
    fields,
  };
}

export function parseGlobal(j: Record<string, unknown>): SObjectMeta[] {
  if (!Array.isArray(j.sobjects)) throw new SalesforceMetadataError('describeGlobal response has no sobjects', 'SF_BAD_METADATA');
  return (j.sobjects as Array<Record<string, unknown>>).map((o) => ({
    name: String(o.name),
    label: str(o.label) ?? String(o.name),
    labelPlural: str(o.labelPlural) ?? str(o.label) ?? String(o.name),
    ...(str(o.keyPrefix) ? { keyPrefix: str(o.keyPrefix) } : {}),
    createable: bool(o.createable),
    updateable: bool(o.updateable),
    deletable: bool(o.deletable),
    queryable: o.queryable !== false,
  }));
}

/** The name field (Name, CaseNumber, Subject...) of an sObject. */
export function nameFieldOf(d: SObjectDescribe): FieldMeta {
  const f = d.fields.find((x) => x.nameField) ?? d.fields.find((x) => x.name === 'Name');
  if (!f) throw new SalesforceMetadataError(`${d.name} has no name field`, 'SF_NO_NAME_FIELD');
  return f;
}

/** Describe served from a snapshot: offline field resolution and impact analysis. */
export class StaticDescribeSource implements DescribeSource {
  constructor(private readonly snapshot: DescribeSnapshot) {
    if (!snapshot || snapshot.schema !== 'eztest.salesforce.describe/v1' || !snapshot.objects) {
      throw new SalesforceMetadataError('Not an EZTest Salesforce describe snapshot (schema eztest.salesforce.describe/v1)', 'SF_BAD_SNAPSHOT');
    }
    if (!Object.keys(snapshot.objects).length) throw new SalesforceMetadataError('Describe snapshot has no objects', 'SF_BAD_SNAPSHOT');
  }

  async describeGlobal(): Promise<SObjectMeta[]> {
    return Object.values(this.snapshot.objects).map(({ fields: _f, ...meta }) => meta);
  }

  async describe(objectName: string): Promise<SObjectDescribe> {
    const hit = Object.values(this.snapshot.objects).find((o) => o.name.toLowerCase() === objectName.toLowerCase());
    if (!hit) throw new SalesforceMetadataError(`sObject "${objectName}" is not in the describe snapshot`, 'SF_UNKNOWN_OBJECT');
    return hit;
  }
}
