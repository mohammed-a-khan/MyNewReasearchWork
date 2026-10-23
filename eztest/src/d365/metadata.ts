/**
 * Dataverse metadata model used by the D365 adapter: entities and their
 * attributes (logical name, display label, type, required level, options).
 * A MetadataSource is either the live DataverseClient or a static snapshot.
 */
import { EzTestError } from '../core/index.js';

export interface OptionMeta {
  value: number;
  label: string;
}

export interface AttributeMeta {
  logicalName: string;
  /** User-localized display label (undefined for unlabeled system columns). */
  displayName?: string;
  /** Dataverse AttributeType, e.g. String, Picklist, Money, Lookup, Boolean, DateTime. */
  attributeType: string;
  /** None | SystemRequired | ApplicationRequired | Recommended. */
  requiredLevel: string;
  /** Choice options (Picklist / Status / State). */
  options?: OptionMeta[];
  /** Two-option labels (Boolean). */
  booleanLabels?: { true: string; false: string };
  /** Lookup targets. */
  targets?: string[];
  isPrimaryName?: boolean;
}

export interface EntityMeta {
  logicalName: string;
  displayName?: string;
  displayCollectionName?: string;
  entitySetName: string;
  primaryIdAttribute: string;
  primaryNameAttribute: string;
}

export interface MetadataSource {
  listEntities(): Promise<EntityMeta[]>;
  getEntity(logicalName: string): Promise<EntityMeta>;
  getAttributes(logicalName: string): Promise<AttributeMeta[]>;
}

/** A metadata snapshot (also the JSON written by snapshotMetadata). */
export interface MetadataSnapshot {
  schema: 'eztest.d365.metadata/v1';
  takenAt: string;
  source?: string;
  entities: Record<string, { entity: EntityMeta; attributes: AttributeMeta[] }>;
}

export class D365MetadataError extends EzTestError {
  constructor(message: string, code = 'D365_METADATA', details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'D365MetadataError';
  }
}

const LOGICAL = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate a logical name before it goes into a URL. */
export function assertLogicalName(name: string, what = 'logical name'): string {
  if (!LOGICAL.test(name)) throw new D365MetadataError(`Invalid ${what} "${name}"`, 'D365_BAD_NAME');
  return name.toLowerCase();
}

/** Metadata served from a snapshot: offline field resolution and impact analysis. */
export class StaticMetadataSource implements MetadataSource {
  constructor(private readonly snapshot: MetadataSnapshot) {
    if (!snapshot || snapshot.schema !== 'eztest.d365.metadata/v1') {
      throw new D365MetadataError('Not an EZTest D365 metadata snapshot (schema eztest.d365.metadata/v1)', 'D365_BAD_SNAPSHOT');
    }
    if (!Object.keys(snapshot.entities).length) throw new D365MetadataError('Metadata snapshot has no entities', 'D365_BAD_SNAPSHOT');
  }

  async listEntities(): Promise<EntityMeta[]> {
    return Object.values(this.snapshot.entities).map((e) => e.entity);
  }

  async getEntity(logicalName: string): Promise<EntityMeta> {
    const e = this.snapshot.entities[logicalName.toLowerCase()];
    if (!e) throw new D365MetadataError(`Entity "${logicalName}" is not in the metadata snapshot`, 'D365_UNKNOWN_ENTITY');
    return e.entity;
  }

  async getAttributes(logicalName: string): Promise<AttributeMeta[]> {
    const e = this.snapshot.entities[logicalName.toLowerCase()];
    if (!e) throw new D365MetadataError(`Entity "${logicalName}" is not in the metadata snapshot`, 'D365_UNKNOWN_ENTITY');
    return e.attributes;
  }
}

type Label = { UserLocalizedLabel?: { Label?: string } | null; LocalizedLabels?: Array<{ Label?: string }> } | null | undefined;

/** DisplayName.UserLocalizedLabel.Label, falling back to the first localized label. */
export function labelOf(l: Label): string | undefined {
  const v = l?.UserLocalizedLabel?.Label ?? l?.LocalizedLabels?.[0]?.Label;
  return v && v.trim() ? v : undefined;
}

export function parseEntityJson(j: Record<string, unknown>): EntityMeta {
  const s = (k: string) => (typeof j[k] === 'string' ? (j[k] as string) : undefined);
  const logicalName = s('LogicalName');
  if (!logicalName || !s('EntitySetName')) throw new D365MetadataError('EntityDefinition without LogicalName/EntitySetName', 'D365_BAD_METADATA');
  return {
    logicalName,
    displayName: labelOf(j.DisplayName as Label),
    displayCollectionName: labelOf(j.DisplayCollectionName as Label),
    entitySetName: s('EntitySetName')!,
    primaryIdAttribute: s('PrimaryIdAttribute') ?? `${logicalName}id`,
    primaryNameAttribute: s('PrimaryNameAttribute') ?? 'name',
  };
}

export function parseAttributeJson(j: Record<string, unknown>): AttributeMeta {
  const logicalName = typeof j.LogicalName === 'string' ? j.LogicalName : undefined;
  if (!logicalName) throw new D365MetadataError('Attribute without LogicalName', 'D365_BAD_METADATA');
  const rl = j.RequiredLevel as { Value?: string } | undefined;
  const a: AttributeMeta = {
    logicalName,
    attributeType: typeof j.AttributeType === 'string' ? j.AttributeType : 'Unknown',
    requiredLevel: rl?.Value ?? 'None',
  };
  const dn = labelOf(j.DisplayName as Label);
  if (dn) a.displayName = dn;
  if (j.IsPrimaryName === true) a.isPrimaryName = true;
  return a;
}

/** Merge OptionSet / Targets details from a type-cast attribute response. */
export function mergeAttributeDetails(a: AttributeMeta, j: Record<string, unknown>): void {
  const os = j.OptionSet as { Options?: Array<{ Value: number; Label: Label }>; TrueOption?: { Label: Label }; FalseOption?: { Label: Label } } | undefined;
  if (os?.Options) a.options = os.Options.map((o) => ({ value: o.Value, label: labelOf(o.Label) ?? String(o.Value) }));
  if (os?.TrueOption || os?.FalseOption) a.booleanLabels = { true: labelOf(os.TrueOption?.Label) ?? 'Yes', false: labelOf(os.FalseOption?.Label) ?? 'No' };
  if (Array.isArray(j.Targets)) a.targets = (j.Targets as unknown[]).filter((t): t is string => typeof t === 'string');
}
