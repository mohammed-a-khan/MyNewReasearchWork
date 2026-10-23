/**
 * Field resolver: label (as users write it) <-> API name (via describe) <->
 * Lightning locator candidates per control type. Resolution is strict: a
 * label shared by two fields is an error, never a guess; typos get
 * suggestions. Locators target the record layout item by its stable API-name
 * attribute first (survives relabels), then by label, then the accessible
 * label, and pierce the components' open shadow roots.
 */
import { NotSupportedError, type LocatorCandidate } from '../core/index.js';
import { normalizeLabel, suggestLabels } from '../d365/resolver.js';
import { SalesforceMetadataError, type DescribeSource, type FieldMeta, type SObjectDescribe, type SObjectMeta } from './metadata.js';

export { normalizeLabel, suggestLabels };

export type SfControl = 'text' | 'textarea' | 'picklist' | 'currency' | 'number' | 'date' | 'checkbox' | 'lookup' | 'unsupported';

/** The Lightning control EZTest drives for a Salesforce field type. */
export function controlFor(type: string): SfControl {
  switch (type) {
    case 'string': case 'phone': case 'email': case 'url': case 'encryptedstring': return 'text';
    case 'textarea': return 'textarea';
    case 'picklist': return 'picklist';
    case 'currency': return 'currency';
    case 'double': case 'int': case 'percent': case 'long': return 'number';
    case 'date': return 'date';
    case 'boolean': return 'checkbox';
    case 'reference': return 'lookup';
    default: return 'unsupported';
  }
}

const css = (value: string): LocatorCandidate => ({ strategy: 'css', value });
const q = (s: string) => s.replace(/(["\\])/g, '\\$1');

/** `records-record-layout-item` selectors of a field: by API name, then by label. */
export function layoutItemSelectors(object: string, field: string, label?: string): string[] {
  const out = [`records-record-layout-item[data-target-selection-name="sfdc:RecordField.${q(object)}.${q(field)}"]`];
  if (label) out.push(`records-record-layout-item[field-label="${q(label)}"]`);
  return out;
}

/** The inner control selector (inside the layout item, through shadow roots) for a control type. */
export function controlSelector(control: SfControl): string | undefined {
  switch (control) {
    case 'text': case 'currency': case 'number': case 'date': return 'lightning-input input:not([type="checkbox"])';
    case 'checkbox': return 'lightning-input input[type="checkbox"]';
    case 'textarea': return 'lightning-textarea textarea';
    case 'picklist': return 'lightning-combobox button[role="combobox"]';
    case 'lookup': return 'lightning-grouped-combobox input[role="combobox"]';
    default: return undefined;
  }
}

/**
 * Ordered locator candidates for the editable control of a field (inside the
 * record edit modal): layout item by API name, by label, then the accessible
 * label. Each candidate must match exactly one element.
 */
export function fieldLocatorCandidates(object: string, field: string, control: SfControl, label?: string): LocatorCandidate[] {
  const inner = controlSelector(control);
  if (!inner) return [];
  const out = layoutItemSelectors(object, field, label).map((item) => css(`${item} ${inner}`));
  if (label && control !== 'checkbox') out.push({ strategy: 'label', value: label, exact: true });
  return out;
}

/** Candidates for the read-only output of a field on the record page (details panel). */
export function outputCandidates(object: string, field: string, label?: string): LocatorCandidate[] {
  return layoutItemSelectors(object, field, label).map((item) => css(`${item} .test-id__field-value`));
}

export interface ResolvedSfField {
  object: string;
  name: string;
  label: string;
  field: FieldMeta;
  control: SfControl;
  /** Editable control candidates (record edit modal). */
  candidates: LocatorCandidate[];
  /** Layout item (container) candidates. */
  containers: LocatorCandidate[];
  /** Output candidates (record page details). */
  outputs: LocatorCandidate[];
  /** Label of the controlling field (dependent picklists). */
  controllerLabel?: string;
}

const quoteList = (xs: string[]) => xs.map((x) => `"${x}"`).join(', ');

export class SalesforceFieldResolver {
  constructor(readonly source: DescribeSource) {}

  /** sObject by API name, label or plural label (case-insensitive, strict). */
  async resolveObject(name: string): Promise<SObjectDescribe> {
    const raw = (name ?? '').trim();
    if (!raw) throw new SalesforceMetadataError('Empty sObject name', 'SF_UNKNOWN_OBJECT');
    let all: SObjectMeta[];
    try {
      all = await this.source.describeGlobal();
    } catch (e) {
      // Without describeGlobal, fall back to the API name.
      if (/^[A-Za-z]\w*$/.test(raw)) return this.source.describe(raw);
      throw e;
    }
    const n = normalizeLabel(raw);
    const hits = all.filter((o) => [o.name, o.label, o.labelPlural].some((x) => normalizeLabel(x) === n));
    const names = [...new Set(hits.map((h) => h.name))];
    if (names.length === 1) return this.source.describe(names[0]);
    if (names.length > 1) throw new SalesforceMetadataError(`sObject name "${raw}" is ambiguous: ${names.join(', ')}`, 'SF_AMBIGUOUS_OBJECT', { candidates: names });
    const s = suggestLabels(raw, all.flatMap((o) => [o.label, o.labelPlural]));
    throw new SalesforceMetadataError(
      `Unknown or inaccessible sObject "${raw}"${s.length ? `. Did you mean ${quoteList(s)}?` : ''}`,
      'SF_UNKNOWN_OBJECT',
      { suggestions: s },
    );
  }

  /** Field by API name or by label; strict single match, suggestions on typos. */
  async resolveFieldMeta(object: string, nameOrLabel: string): Promise<{ describe: SObjectDescribe; field: FieldMeta }> {
    const d = await this.source.describe(object);
    const raw = (nameOrLabel ?? '').trim();
    if (!raw) throw new SalesforceMetadataError(`Empty field name on ${d.name}`, 'SF_UNKNOWN_FIELD');
    const byApi = d.fields.find((f) => f.name.toLowerCase() === raw.toLowerCase());
    if (byApi) return { describe: d, field: byApi };
    const n = normalizeLabel(raw);
    const byLabel = d.fields.filter((f) => normalizeLabel(f.label) === n);
    if (byLabel.length === 1) return { describe: d, field: byLabel[0] };
    if (byLabel.length > 1) {
      throw new SalesforceMetadataError(
        `Field label "${raw}" is ambiguous on ${d.name}: ${byLabel.map((f) => f.name).join(', ')}. Use the API name instead.`,
        'SF_AMBIGUOUS_FIELD',
        { candidates: byLabel.map((f) => f.name) },
      );
    }
    const s = suggestLabels(raw, d.fields.map((f) => f.label));
    throw new SalesforceMetadataError(
      `Field "${raw}" not found on ${d.name}${s.length ? `. Did you mean ${quoteList(s)}?` : ''}`,
      'SF_UNKNOWN_FIELD',
      { suggestions: s, object: d.name },
    );
  }

  async resolveField(object: string, nameOrLabel: string): Promise<ResolvedSfField> {
    const { describe: d, field: f } = await this.resolveFieldMeta(object, nameOrLabel);
    const control = controlFor(f.type);
    return {
      object: d.name,
      name: f.name,
      label: f.label,
      field: f,
      control,
      candidates: fieldLocatorCandidates(d.name, f.name, control, f.label),
      containers: layoutItemSelectors(d.name, f.name, f.label).map(css),
      outputs: outputCandidates(d.name, f.name, f.label),
      ...(f.controllerName ? { controllerLabel: d.fields.find((x) => x.name === f.controllerName)?.label ?? f.controllerName } : {}),
    };
  }

  async apiNameOf(object: string, nameOrLabel: string): Promise<string> {
    return (await this.resolveFieldMeta(object, nameOrLabel)).field.name;
  }

  async labelOf(object: string, apiName: string): Promise<string> {
    return (await this.resolveFieldMeta(object, apiName)).field.label;
  }
}

/** Throw NotSupportedError for field types EZTest cannot drive in Lightning. */
export function assertDrivable(f: ResolvedSfField): void {
  if (f.control === 'unsupported') {
    throw new NotSupportedError(`setting/reading Salesforce field "${f.label}" (${f.name}) of type ${f.field.type} in Lightning`);
  }
}
