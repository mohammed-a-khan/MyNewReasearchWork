/**
 * Field resolver: display label (as users write it) <-> logical name <-> UCI
 * locator candidates. Resolution is strict: a label that matches two
 * attributes is an error, never a guess. Exported for reuse by importers
 * (RSAT / Task Recorder), which see either labels or logical names.
 */
import type { LocatorCandidate } from '../core/index.js';
import { NotSupportedError } from '../core/index.js';
import { D365MetadataError, type AttributeMeta, type EntityMeta, type MetadataSource } from './metadata.js';

export type D365ControlType = 'text' | 'optionset' | 'money' | 'number' | 'twooptions' | 'date' | 'lookup' | 'unsupported';

/** The UCI control EZTest drives for a Dataverse AttributeType. */
export function controlTypeFor(attributeType: string): D365ControlType {
  switch (attributeType) {
    case 'String': case 'Memo': return 'text';
    case 'Picklist': case 'Status': case 'State': return 'optionset';
    case 'Money': return 'money';
    case 'Integer': case 'Decimal': case 'Double': case 'BigInt': return 'number';
    case 'Boolean': return 'twooptions';
    case 'DateTime': return 'date';
    case 'Lookup': case 'Customer': case 'Owner': return 'lookup';
    default: return 'unsupported';
  }
}

/** Normalise a label for comparison: case, whitespace, trailing "*" / ":" (required markers). */
export function normalizeLabel(s: string): string {
  return s.replace(/[\s\u00a0]+/g, ' ').replace(/[\s*:]+$/, '').trim().toLowerCase();
}

/** Web API column name of an attribute (lookups are exposed as _x_value). */
export function webApiColumn(a: AttributeMeta): string {
  return controlTypeFor(a.attributeType) === 'lookup' ? `_${a.logicalName}_value` : a.logicalName;
}

const css = (value: string): LocatorCandidate => ({ strategy: 'css', value });
const q = (s: string) => s.replace(/(["\\])/g, '\\$1');

/** UCI data-id prefix of a lookup control. */
export function lookupPrefix(logicalName: string): string {
  return `${logicalName}.fieldControl-LookupResultsDropdown_${logicalName}`;
}

/** Selectors of a lookup control's parts (input, results flyout, selected tag, delete button). */
export function lookupSelectors(logicalName: string) {
  const p = q(lookupPrefix(logicalName));
  return {
    input: `input[data-id="${p}_textInputBox_with_filter_new"]`,
    results: `[data-id="${p}_resultsContainer"]`,
    option: `[data-id="${p}_resultsContainer"] li[role="option"]`,
    selectedTag: `[data-id="${p}_selected_tag_text"]`,
    deleteTag: `button[data-id="${p}_selected_tag_delete"]`,
  };
}

/**
 * Ordered locator candidates for the input of a field: the UCI data-id
 * patterns of its control type first, then the field container, then the
 * label. Candidates are tried in order and each must match exactly one element.
 */
export function fieldLocatorCandidates(logicalName: string, control: D365ControlType, label?: string): LocatorCandidate[] {
  const n = q(logicalName);
  const out: LocatorCandidate[] = [];
  switch (control) {
    case 'text':
      for (const s of ['text-box-text', 'phone-text-input', 'mail-text-input', 'url-text-input', 'ticker-text-input']) {
        out.push(css(`input[data-id="${n}.fieldControl-${s}"]`));
      }
      out.push(css(`textarea[data-id="${n}.fieldControl-text-box-text"]`));
      break;
    case 'optionset':
      out.push(css(`select[data-id="${n}.fieldControl-option-set-select"]`));
      break;
    case 'money':
      out.push(css(`input[data-id="${n}.fieldControl-currency-text-input"]`));
      break;
    case 'number':
      for (const s of ['whole-number-text-input', 'decimal-number-text-input', 'float-number-text-input', 'duration-combobox-text']) {
        out.push(css(`input[data-id="${n}.fieldControl-${s}"]`));
      }
      break;
    case 'twooptions':
      out.push(css(`input[data-id="${n}.fieldControl-checkbox-toggle"]`));
      out.push(css(`select[data-id="${n}.fieldControl-checkbox-select"]`));
      out.push(css(`[data-id="${n}.fieldControl-checkbox-container"] input`));
      break;
    case 'date':
      out.push(css(`input[data-id="${n}.fieldControl-date-time-input"]`));
      break;
    case 'lookup':
      out.push(css(lookupSelectors(logicalName).input));
      break;
    case 'unsupported':
      break;
  }
  if (control !== 'lookup') out.push(css(`div[data-id="${n}"] :is(input:not([type="hidden"]), select, textarea)`));
  if (label) out.push({ strategy: 'label', value: label, exact: true });
  return out;
}

/** Container of a field on the form (`div[data-id="<logical>"]`). */
export function fieldContainerCandidate(logicalName: string): LocatorCandidate {
  return css(`div[data-id="${q(logicalName)}"]`);
}

export interface ResolvedField {
  entity: string;
  logicalName: string;
  label?: string;
  attribute: AttributeMeta;
  control: D365ControlType;
  /** Web API column (lookups: `_x_value`). */
  column: string;
  candidates: LocatorCandidate[];
  container: LocatorCandidate;
}

function levenshtein(a: string, b: string): number {
  const d: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}

/** Closest labels: small edit distance or a shared word. */
export function suggestLabels(wanted: string, labels: string[], max = 3): string[] {
  const w = normalizeLabel(wanted);
  const words = new Set(w.split(' ').filter((x) => x.length > 2));
  const scored = labels
    .map((l) => {
      const n = normalizeLabel(l);
      const dist = levenshtein(w, n);
      const shared = n.split(' ').filter((x) => words.has(x)).length;
      return { l, score: dist <= 3 ? 100 - dist : shared ? 50 + shared : -1 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.l.localeCompare(b.l));
  return [...new Set(scored.map((s) => s.l))].slice(0, max);
}

export class FieldResolver {
  constructor(readonly source: MetadataSource) {}

  /** Entity by logical name, display name or plural display name (case-insensitive, strict). */
  async resolveEntity(name: string): Promise<EntityMeta> {
    const raw = name.trim();
    if (!raw) throw new D365MetadataError('Empty entity name', 'D365_UNKNOWN_ENTITY');
    const n = normalizeLabel(raw);
    if (/^[a-z_][a-z0-9_]*$/i.test(raw)) {
      try {
        return await this.source.getEntity(raw.toLowerCase());
      } catch (e) {
        if (!(e instanceof D365MetadataError)) throw e;
      }
    }
    const all = await this.source.listEntities();
    const hits = all.filter((e) =>
      [e.logicalName, e.displayName, e.displayCollectionName].some((x) => x !== undefined && normalizeLabel(x) === n),
    );
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new D365MetadataError(`Entity name "${raw}" is ambiguous: ${hits.map((h) => h.logicalName).join(', ')}`, 'D365_AMBIGUOUS_ENTITY');
    }
    const names = all.flatMap((e) => [e.displayName, e.displayCollectionName].filter((x): x is string => !!x));
    const s = suggestLabels(raw, names);
    throw new D365MetadataError(`Unknown entity "${raw}"${s.length ? `. Did you mean ${s.map((x) => `"${x}"`).join(', ')}?` : ''}`, 'D365_UNKNOWN_ENTITY', { suggestions: s });
  }

  /** Attribute by logical name (or `_x_value`) or by display label; strict single match. */
  async resolveAttribute(entity: string, nameOrLabel: string): Promise<AttributeMeta> {
    const raw = nameOrLabel.trim();
    if (!raw) throw new D365MetadataError(`Empty field name on ${entity}`, 'D365_UNKNOWN_FIELD');
    const attrs = await this.source.getAttributes(entity);
    const lower = raw.toLowerCase();
    const logical = /^_(\w+)_value$/.exec(lower)?.[1] ?? lower;
    const byLogical = attrs.find((a) => a.logicalName.toLowerCase() === logical);
    if (byLogical) return byLogical;
    const n = normalizeLabel(raw);
    const byLabel = attrs.filter((a) => a.displayName !== undefined && normalizeLabel(a.displayName) === n);
    if (byLabel.length === 1) return byLabel[0];
    if (byLabel.length > 1) {
      throw new D365MetadataError(
        `Field label "${raw}" is ambiguous on ${entity}: ${byLabel.map((a) => a.logicalName).join(', ')}. Use the logical name instead.`,
        'D365_AMBIGUOUS_FIELD',
        { candidates: byLabel.map((a) => a.logicalName) },
      );
    }
    const s = suggestLabels(raw, attrs.map((a) => a.displayName).filter((x): x is string => !!x));
    throw new D365MetadataError(
      `Field "${raw}" not found on ${entity}${s.length ? `. Did you mean ${s.map((x) => `"${x}"`).join(', ')}?` : ''}`,
      'D365_UNKNOWN_FIELD',
      { suggestions: s },
    );
  }

  async resolveField(entity: string, nameOrLabel: string): Promise<ResolvedField> {
    const a = await this.resolveAttribute(entity, nameOrLabel);
    const control = controlTypeFor(a.attributeType);
    return {
      entity,
      logicalName: a.logicalName,
      label: a.displayName,
      attribute: a,
      control,
      column: webApiColumn(a),
      candidates: fieldLocatorCandidates(a.logicalName, control, a.displayName),
      container: fieldContainerCandidate(a.logicalName),
    };
  }

  /** Display label of a logical name (undefined when the attribute has none). */
  async labelOf(entity: string, logicalName: string): Promise<string | undefined> {
    return (await this.resolveAttribute(entity, logicalName)).displayName;
  }

  /** Logical name of a display label (or logical name). */
  async logicalNameOf(entity: string, nameOrLabel: string): Promise<string> {
    return (await this.resolveAttribute(entity, nameOrLabel)).logicalName;
  }
}

/** Throw NotSupportedError for attribute types EZTest cannot drive on a form. */
export function assertDrivable(f: ResolvedField): void {
  if (f.control === 'unsupported') {
    throw new NotSupportedError(`setting/reading D365 field "${f.label ?? f.logicalName}" of type ${f.attribute.attributeType} on a form`);
  }
}
