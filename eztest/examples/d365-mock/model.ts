/**
 * Metadata + in-memory record store for the Dynamics 365 / Dataverse mock.
 *
 * The shapes mirror what the Dataverse Web API returns (EntityDefinitions /
 * AttributeMetadata), so the adapter is exercised against realistic JSON.
 * `releaseWave` switches the metadata to a "next release" variant that
 * relabels, removes, adds and re-requires attributes and changes a control.
 */
import { randomUUID } from 'node:crypto';

export type MockAttributeType =
  | 'String' | 'Memo' | 'Picklist' | 'Status' | 'State' | 'Money' | 'Integer' | 'Decimal'
  | 'Boolean' | 'DateTime' | 'Lookup' | 'Customer' | 'Owner' | 'Uniqueidentifier';

export type RequiredLevel = 'None' | 'SystemRequired' | 'ApplicationRequired' | 'Recommended';

export interface MockOption {
  value: number;
  label: string;
}

export interface MockAttribute {
  logicalName: string;
  label: string | null;
  type: MockAttributeType;
  required: RequiredLevel;
  options?: MockOption[];
  /** Boolean labels: [false, true]. */
  booleanLabels?: [string, string];
  targets?: string[];
  /** Control used on the form; default derived from type. */
  control?: 'text' | 'phone' | 'email' | 'optionset' | 'money' | 'number' | 'toggle' | 'date' | 'lookup';
  /** Rendered on the main form. */
  onForm?: boolean;
  /** Shown as a grid column in the default view. */
  inView?: boolean;
  maxLength?: number;
}

export interface MockEntity {
  logicalName: string;
  displayName: string;
  collectionName: string;
  entitySetName: string;
  primaryId: string;
  primaryName: string;
  viewName: string;
  attributes: MockAttribute[];
  /** Business process flow stages (in order) and the steps that gate leaving each stage. */
  bpf?: { name: string; stages: Array<{ name: string; requires?: string[] }> };
  metadataId: string;
}

const ACCOUNT_STATUS: MockOption[] = [
  { value: 1, label: 'Active' },
  { value: 2, label: 'Inactive' },
];
const INDUSTRY: MockOption[] = [
  { value: 1, label: 'Accounting' },
  { value: 2, label: 'Agriculture and Non-petrol Natural Resource Extraction' },
  { value: 3, label: 'Broadcasting Printing and Publishing' },
  { value: 4, label: 'Brokers' },
  { value: 6, label: 'Business Services' },
  { value: 7, label: 'Consulting' },
  { value: 8, label: 'Consumer Services' },
  { value: 33, label: 'Wholesale' },
];
const OPP_STATUS: MockOption[] = [
  { value: 1, label: 'In Progress' },
  { value: 2, label: 'On Hold' },
  { value: 3, label: 'Won' },
  { value: 4, label: 'Canceled' },
];
const RATING: MockOption[] = [
  { value: 1, label: 'Default Value' },
  { value: 2, label: 'Strategic' },
];

function account(wave: boolean): MockEntity {
  const attrs: MockAttribute[] = [
    { logicalName: 'accountid', label: 'Account', type: 'Uniqueidentifier', required: 'SystemRequired' },
    { logicalName: 'name', label: 'Account Name', type: 'String', required: 'ApplicationRequired', onForm: true, inView: true, maxLength: 160 },
    { logicalName: 'accountnumber', label: 'Account Number', type: 'String', required: wave ? 'ApplicationRequired' : 'None', onForm: true, maxLength: 20 },
    {
      logicalName: 'telephone1', label: wave ? 'Business Phone' : 'Main Phone', type: 'String', required: 'None', onForm: true, inView: true,
      control: wave ? 'phone' : 'text', maxLength: 50,
    },
    { logicalName: 'revenue', label: 'Annual Revenue', type: 'Money', required: 'None', onForm: true, inView: true },
    { logicalName: 'industrycode', label: 'Industry', type: 'Picklist', required: 'None', options: INDUSTRY, onForm: true },
    { logicalName: 'parentaccountid', label: 'Parent Account', type: 'Lookup', required: 'None', targets: ['account'], onForm: true, inView: true },
    { logicalName: 'creditonhold', label: 'Credit Hold', type: 'Boolean', required: 'None', booleanLabels: ['No', 'Yes'], onForm: true },
    { logicalName: 'lastusedincampaign', label: 'Last Date Included in Campaign', type: 'DateTime', required: 'None', onForm: true },
    { logicalName: 'numberofemployees', label: 'Number of Employees', type: 'Integer', required: 'None', onForm: true },
    { logicalName: 'statecode', label: 'Status', type: 'State', required: 'SystemRequired', options: ACCOUNT_STATUS },
    { logicalName: 'statuscode', label: 'Status Reason', type: 'Status', required: 'None', options: ACCOUNT_STATUS, onForm: true },
    { logicalName: 'createdon', label: 'Created On', type: 'DateTime', required: 'None' },
    { logicalName: 'ownerid', label: 'Owner', type: 'Owner', required: 'SystemRequired', targets: ['systemuser', 'team'] },
  ];
  if (!wave) {
    attrs.splice(4, 0, { logicalName: 'fax', label: 'Fax', type: 'String', required: 'None', onForm: true, maxLength: 50 });
  } else {
    attrs.push({ logicalName: 'accountratingcode', label: 'Account Rating', type: 'Picklist', required: 'None', options: RATING, onForm: true });
  }
  return {
    logicalName: 'account', displayName: 'Account', collectionName: 'Accounts', entitySetName: 'accounts',
    primaryId: 'accountid', primaryName: 'name', viewName: 'Active Accounts', attributes: attrs,
    metadataId: '70816501-edb9-4740-a16c-6a5efbc05d84',
  };
}

function opportunity(): MockEntity {
  return {
    logicalName: 'opportunity', displayName: 'Opportunity', collectionName: 'Opportunities', entitySetName: 'opportunities',
    primaryId: 'opportunityid', primaryName: 'name', viewName: 'Open Opportunities', metadataId: '3e1a1d64-77a3-4cb2-9a7d-5b1f3b8a6a10',
    attributes: [
      { logicalName: 'opportunityid', label: 'Opportunity', type: 'Uniqueidentifier', required: 'SystemRequired' },
      { logicalName: 'name', label: 'Topic', type: 'String', required: 'ApplicationRequired', onForm: true, inView: true, maxLength: 300 },
      { logicalName: 'parentaccountid', label: 'Account', type: 'Lookup', required: 'None', targets: ['account'], onForm: true, inView: true },
      { logicalName: 'estimatedvalue', label: 'Est. Revenue', type: 'Money', required: 'None', onForm: true, inView: true },
      { logicalName: 'estimatedclosedate', label: 'Est. Close Date', type: 'DateTime', required: 'None', onForm: true },
      { logicalName: 'statuscode', label: 'Status Reason', type: 'Status', required: 'None', options: OPP_STATUS, onForm: true },
      { logicalName: 'stepname', label: 'Pipeline Phase', type: 'String', required: 'None', inView: true },
      { logicalName: 'createdon', label: 'Created On', type: 'DateTime', required: 'None' },
    ],
    bpf: {
      name: 'Opportunity Sales Process',
      stages: [{ name: 'Qualify', requires: ['parentaccountid'] }, { name: 'Develop' }, { name: 'Propose' }, { name: 'Close' }],
    },
  };
}

export function entities(wave: boolean): MockEntity[] {
  return [account(wave), opportunity()];
}

export type RecordValue = string | number | boolean | null;
export type MockRecord = Record<string, RecordValue>;

/** In-memory Dataverse tables, keyed by entity logical name then record id. */
export class MockStore {
  readonly tables = new Map<string, Map<string, MockRecord>>();

  constructor() {
    this.tables.set('account', new Map());
    this.tables.set('opportunity', new Map());
    this.seed();
  }

  private seed(): void {
    const fab = this.insert('account', { name: 'Fabrikam', telephone1: '555-0111', revenue: 5_000_000, industrycode: 6, statuscode: 1, statecode: 0, creditonhold: false });
    this.insert('account', { name: 'Fabrikam Holdings', telephone1: '555-0112', revenue: 9_000_000, industrycode: 4, statuscode: 1, statecode: 0, creditonhold: false });
    this.insert('account', { name: 'Adventure Works', telephone1: '555-0113', revenue: 750_000, industrycode: 33, statuscode: 1, statecode: 0, creditonhold: false, _parentaccountid_value: fab });
  }

  table(entity: string): Map<string, MockRecord> {
    const t = this.tables.get(entity);
    if (!t) throw new Error(`no table ${entity}`);
    return t;
  }

  insert(entity: string, data: MockRecord): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    const pk = entity === 'account' ? 'accountid' : 'opportunityid';
    const rec: MockRecord = { [pk]: id, statecode: 0, statuscode: 1, createdon: now, modifiedon: now, ...data };
    if (entity === 'opportunity' && rec.stepname == null) rec.stepname = 'Qualify';
    this.table(entity).set(id, rec);
    return id;
  }

  update(entity: string, id: string, data: MockRecord): boolean {
    const rec = this.table(entity).get(id);
    if (!rec) return false;
    Object.assign(rec, data, { modifiedon: new Date().toISOString() });
    return true;
  }

  nameOf(entity: string, id: string | null | undefined): string | undefined {
    if (!id) return undefined;
    const r = this.tables.get(entity)?.get(id);
    return r ? String(r.name ?? '') : undefined;
  }
}
