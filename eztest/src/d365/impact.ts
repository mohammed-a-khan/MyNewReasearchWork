/**
 * Release-wave impact analysis: snapshot Dataverse metadata, diff two
 * snapshots (added / removed / relabeled / type-changed / required-changed /
 * options-changed attributes) and list the journeys whose steps reference a
 * changed field by label, logical name or UCI data-id, with reasons.
 */
import { EzTestError, nowIso, type Journey, type Step } from '../core/index.js';
import type { AttributeMeta, EntityMeta, MetadataSnapshot, MetadataSource } from './metadata.js';
import { normalizeLabel } from './resolver.js';

/** Snapshot the metadata of `entities` (logical names) into JSON-safe form. */
export async function snapshotMetadata(source: MetadataSource, entities: string[], o: { source?: string } = {}): Promise<MetadataSnapshot> {
  const names = [...new Set(entities.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!names.length) throw new EzTestError('snapshotMetadata: no entities given', 'INVALID_INPUT');
  const out: MetadataSnapshot = { schema: 'eztest.d365.metadata/v1', takenAt: nowIso(), entities: {} };
  if (o.source) out.source = o.source;
  for (const n of names) {
    const [entity, attributes] = await Promise.all([source.getEntity(n), source.getAttributes(n)]);
    out.entities[n] = {
      entity: { ...entity },
      attributes: attributes.map((a) => JSON.parse(JSON.stringify(a)) as AttributeMeta).sort((a, b) => a.logicalName.localeCompare(b.logicalName)),
    };
  }
  return out;
}

export type AttributeChangeKind = 'added' | 'removed' | 'relabeled' | 'type-changed' | 'required-changed' | 'options-changed';

export interface AttributeChange {
  entity: string;
  logicalName: string;
  change: AttributeChangeKind;
  before?: AttributeMeta;
  after?: AttributeMeta;
  detail: string;
}

export interface MetadataDiff {
  before: { takenAt: string };
  after: { takenAt: string };
  entities: { added: string[]; removed: string[] };
  /** Every name an entity is known by (logical, display, collection), from both snapshots. */
  entityNames: Record<string, string[]>;
  changes: AttributeChange[];
  added: AttributeChange[];
  removed: AttributeChange[];
  relabeled: AttributeChange[];
  typeChanged: AttributeChange[];
  requiredChanged: AttributeChange[];
  optionsChanged: AttributeChange[];
}

const optionKey = (a: AttributeMeta) =>
  JSON.stringify([(a.options ?? []).map((o) => [o.value, o.label]), a.booleanLabels ? [a.booleanLabels.true, a.booleanLabels.false] : null]);

function names(e: EntityMeta | undefined): string[] {
  return e ? [e.logicalName, e.displayName, e.displayCollectionName].filter((x): x is string => !!x) : [];
}

function checkSnapshot(s: MetadataSnapshot, which: string): void {
  if (!s || s.schema !== 'eztest.d365.metadata/v1' || !s.entities) throw new EzTestError(`diffMetadata: ${which} is not a metadata snapshot`, 'INVALID_INPUT');
}

export function diffMetadata(before: MetadataSnapshot, after: MetadataSnapshot): MetadataDiff {
  checkSnapshot(before, 'before');
  checkSnapshot(after, 'after');
  const bE = Object.keys(before.entities);
  const aE = Object.keys(after.entities);
  if (!bE.length && !aE.length) throw new EzTestError('diffMetadata: both snapshots are empty', 'INVALID_INPUT');
  const changes: AttributeChange[] = [];
  const entityNames: Record<string, string[]> = {};
  for (const n of new Set([...bE, ...aE])) {
    entityNames[n] = [...new Set([...names(before.entities[n]?.entity), ...names(after.entities[n]?.entity)])];
  }
  for (const n of bE.filter((x) => aE.includes(x))) {
    const b = new Map(before.entities[n].attributes.map((a) => [a.logicalName, a]));
    const a = new Map(after.entities[n].attributes.map((x) => [x.logicalName, x]));
    for (const [ln, x] of b) {
      const y = a.get(ln);
      const label = x.displayName ?? ln;
      if (!y) {
        changes.push({ entity: n, logicalName: ln, change: 'removed', before: x, detail: `"${label}" (${ln}) was removed from ${n}` });
        continue;
      }
      if ((x.displayName ?? '') !== (y.displayName ?? '')) {
        changes.push({ entity: n, logicalName: ln, change: 'relabeled', before: x, after: y, detail: `${n}.${ln} label "${x.displayName ?? ''}" became "${y.displayName ?? ''}"` });
      }
      if (x.attributeType !== y.attributeType) {
        changes.push({ entity: n, logicalName: ln, change: 'type-changed', before: x, after: y, detail: `${n}.${ln} ("${label}") type ${x.attributeType} became ${y.attributeType}` });
      }
      if (x.requiredLevel !== y.requiredLevel) {
        changes.push({ entity: n, logicalName: ln, change: 'required-changed', before: x, after: y, detail: `${n}.${ln} ("${y.displayName ?? ln}") required level ${x.requiredLevel} became ${y.requiredLevel}` });
      }
      if (optionKey(x) !== optionKey(y)) {
        changes.push({ entity: n, logicalName: ln, change: 'options-changed', before: x, after: y, detail: `${n}.${ln} ("${y.displayName ?? ln}") choice options changed` });
      }
    }
    for (const [ln, y] of a) {
      if (!b.has(ln)) changes.push({ entity: n, logicalName: ln, change: 'added', after: y, detail: `"${y.displayName ?? ln}" (${ln}, ${y.attributeType}, ${y.requiredLevel}) was added to ${n}` });
    }
  }
  const of = (k: AttributeChangeKind) => changes.filter((c) => c.change === k);
  return {
    before: { takenAt: before.takenAt },
    after: { takenAt: after.takenAt },
    entities: { added: aE.filter((x) => !bE.includes(x)), removed: bE.filter((x) => !aE.includes(x)) },
    entityNames,
    changes,
    added: of('added'),
    removed: of('removed'),
    relabeled: of('relabeled'),
    typeChanged: of('type-changed'),
    requiredChanged: of('required-changed'),
    optionsChanged: of('options-changed'),
  };
}

export interface ImpactReason {
  stepId: string;
  intent: string;
  entity: string;
  logicalName: string;
  change: AttributeChangeKind | 'entity-removed';
  matchedBy: 'label' | 'logical-name' | 'locator' | 'creates-record' | 'entity';
  matched: string;
  /** breaking: the step will fail as written; review: likely affected, check it. */
  severity: 'breaking' | 'review';
  detail: string;
}

export interface D365ImpactedJourney {
  journeyId: string;
  name: string;
  risk: number;
  breaking: number;
  reasons: ImpactReason[];
}

const REQUIRED = new Set(['ApplicationRequired', 'SystemRequired']);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (s: string) => new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRe(s).replace(/\s+/g, '\\s+')}(?![A-Za-z0-9_])`, 'i');

/** Field references a step makes explicitly (D365 step args). */
function fieldRefs(step: Step): string[] {
  const a = step.args ?? {};
  const out: string[] = [];
  if (typeof a.field === 'string') out.push(a.field);
  if (a.expect && typeof a.expect === 'object') out.push(...Object.keys(a.expect as Record<string, unknown>));
  return out;
}

/** Free text a step carries: intent, value, target description/locators, post-conditions. */
function stepTexts(step: Step): { text: string[]; locators: string[] } {
  const text = [step.intent, step.value ?? '', step.target?.description ?? ''];
  const locators = (step.target?.locators ?? []).flatMap((l) => [l.value, l.name ?? '']);
  if (step.postconditions.length) text.push(JSON.stringify(step.postconditions));
  return { text: text.filter(Boolean), locators: locators.filter(Boolean) };
}

/**
 * Journeys whose steps reference changed fields. Labels are matched as written
 * by users (old label for relabels/removals), logical names as words and in
 * UCI data-ids. D365 steps are scoped to the entity of the most recent
 * open-form/record/view step; other steps are matched on any entity.
 */
export function impactedJourneys(diff: MetadataDiff, journeys: Journey[]): D365ImpactedJourney[] {
  if (!diff || !Array.isArray(diff.changes)) throw new EzTestError('impactedJourneys: not a metadata diff', 'INVALID_INPUT');
  if (!journeys.length) throw new EzTestError('impactedJourneys: no journeys given', 'INVALID_INPUT');
  const entityOf = (name: string): string | undefined => {
    const n = normalizeLabel(name);
    return Object.entries(diff.entityNames).find(([, ns]) => ns.some((x) => normalizeLabel(x) === n))?.[0];
  };
  const out: D365ImpactedJourney[] = [];
  for (const j of journeys) {
    const reasons: ImpactReason[] = [];
    let current: string | undefined;
    const created = new Map<string, Step>();
    const setFields = new Map<string, Set<string>>();
    for (const step of j.steps) {
      const h = step.handler ?? '';
      const argEntity = typeof step.args?.entity === 'string' ? entityOf(step.args.entity) : undefined;
      if (h === 'd365.openForm' || h === 'd365.openRecord' || h === 'd365.openView') current = argEntity;
      if (h === 'd365.openForm' && argEntity) created.set(argEntity, step);
      const scope = h === 'd365.verifyDataverse' || h === 'd365.expectView' ? argEntity : h.startsWith('d365.') ? current : undefined;
      if (h === 'd365.setField' && current) {
        const s = setFields.get(current) ?? new Set<string>();
        s.add(normalizeLabel(String(step.args?.field ?? '')));
        setFields.set(current, s);
      }
      if (step.args?.entity && typeof step.args.entity === 'string' && diff.entities.removed.includes(argEntity ?? '')) {
        reasons.push({ stepId: step.id, intent: step.intent, entity: argEntity!, logicalName: '', change: 'entity-removed', matchedBy: 'entity', matched: step.args.entity, severity: 'breaking', detail: `entity ${argEntity} no longer exists` });
      }
      const refs = fieldRefs(step).map(normalizeLabel);
      const { text, locators } = stepTexts(step);
      for (const c of diff.changes) {
        if (c.change === 'added') continue;
        if (scope && scope !== c.entity) continue;
        const ln = c.logicalName.toLowerCase();
        const oldLabel = c.before?.displayName;
        const newLabel = c.after?.displayName;
        // Labels that, if referenced, point at the changed field.
        const labels = c.change === 'relabeled' || c.change === 'removed' ? [oldLabel] : [newLabel ?? oldLabel];
        const breaking = c.change === 'removed' || c.change === 'relabeled' || c.change === 'type-changed';
        let hit: Pick<ImpactReason, 'matchedBy' | 'matched' | 'severity'> | undefined;
        for (const l of labels) {
          if (!l || hit) continue;
          const nl = normalizeLabel(l);
          if (refs.includes(nl) || text.some((t) => wordRe(l).test(t))) hit = { matchedBy: 'label', matched: l, severity: breaking ? 'breaking' : 'review' };
        }
        if (!hit && (refs.includes(ln) || refs.includes(`_${ln}_value`) || text.some((t) => wordRe(ln).test(t)))) {
          hit = { matchedBy: 'logical-name', matched: c.logicalName, severity: c.change === 'removed' || c.change === 'type-changed' ? 'breaking' : 'review' };
        }
        if (!hit && locators.some((l) => l.includes(`"${c.logicalName}.fieldControl`) || l.includes(`"${c.logicalName}"`))) {
          hit = { matchedBy: 'locator', matched: c.logicalName, severity: c.change === 'removed' ? 'breaking' : 'review' };
        }
        if (hit) reasons.push({ stepId: step.id, intent: step.intent, entity: c.entity, logicalName: c.logicalName, change: c.change, ...hit, detail: c.detail });
      }
    }
    // Newly required fields break journeys that create records of that entity without setting them.
    for (const c of diff.changes) {
      const nowRequired = (c.change === 'required-changed' || c.change === 'added') && REQUIRED.has(c.after?.requiredLevel ?? '') && !REQUIRED.has(c.before?.requiredLevel ?? '');
      const step = created.get(c.entity);
      if (!nowRequired || !step) continue;
      const set = setFields.get(c.entity) ?? new Set();
      const label = c.after?.displayName;
      if (set.has(c.logicalName.toLowerCase()) || (label && set.has(normalizeLabel(label)))) continue;
      reasons.push({
        stepId: step.id, intent: step.intent, entity: c.entity, logicalName: c.logicalName, change: c.change, matchedBy: 'creates-record',
        matched: label ?? c.logicalName, severity: 'breaking',
        detail: `"${label ?? c.logicalName}" is now required on ${c.entity}; this journey creates a ${c.entity} without setting it`,
      });
    }
    if (reasons.length) {
      out.push({ journeyId: j.id, name: j.name, risk: j.risk, breaking: reasons.filter((r) => r.severity === 'breaking').length, reasons });
    }
  }
  return out.sort((a, b) => b.breaking - a.breaking || b.risk - a.risk || a.journeyId.localeCompare(b.journeyId));
}
