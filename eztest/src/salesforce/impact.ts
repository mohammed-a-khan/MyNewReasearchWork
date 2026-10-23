/**
 * Release impact analysis: snapshot sObject describes, diff two snapshots
 * (added / removed / relabeled / type-changed / required-changed /
 * picklist-changed fields) and list the journeys whose steps are affected:
 * steps that reference a changed field (by label, API name or Lightning
 * locator), journeys that create records of an object that gained a required
 * field without setting it, and steps that use a picklist value the release
 * removed.
 */
import { EzTestError, nowIso, type Journey, type Step } from '../core/index.js';
import type { DescribeSnapshot, DescribeSource, FieldMeta, SObjectDescribe } from './metadata.js';
import { normalizeLabel } from './resolver.js';

/** Snapshot the describe of `objects` (API names or labels resolved by the source) into JSON-safe form. */
export async function snapshotDescribe(source: DescribeSource, objects: string[], o: { source?: string; release?: string } = {}): Promise<DescribeSnapshot> {
  const names = [...new Set(objects.map((x) => x.trim()).filter(Boolean))];
  if (!names.length) throw new EzTestError('snapshotDescribe: no objects given', 'INVALID_INPUT');
  const out: DescribeSnapshot = { schema: 'eztest.salesforce.describe/v1', takenAt: nowIso(), objects: {} };
  if (o.source) out.source = o.source;
  if (o.release) out.release = o.release;
  for (const n of names) {
    const d = await source.describe(n);
    const copy = JSON.parse(JSON.stringify(d)) as SObjectDescribe;
    copy.fields.sort((a, b) => a.name.localeCompare(b.name));
    out.objects[d.name] = copy;
  }
  return out;
}

export type FieldChangeKind = 'added' | 'removed' | 'relabeled' | 'type-changed' | 'required-changed' | 'picklist-changed';

export interface FieldChange {
  object: string;
  field: string;
  change: FieldChangeKind;
  before?: FieldMeta;
  after?: FieldMeta;
  /** picklist-changed: values (API names) removed / added. */
  removedValues?: string[];
  addedValues?: string[];
  detail: string;
}

export interface DescribeDiff {
  before: { takenAt: string; release?: string };
  after: { takenAt: string; release?: string };
  objects: { added: string[]; removed: string[] };
  /** Every name an object is known by (API name, label, plural label), from both snapshots. */
  objectNames: Record<string, string[]>;
  changes: FieldChange[];
  added: FieldChange[];
  removed: FieldChange[];
  relabeled: FieldChange[];
  typeChanged: FieldChange[];
  requiredChanged: FieldChange[];
  picklistChanged: FieldChange[];
}

function check(s: DescribeSnapshot, which: string): void {
  if (!s || s.schema !== 'eztest.salesforce.describe/v1' || !s.objects) throw new EzTestError(`diffDescribe: ${which} is not a Salesforce describe snapshot`, 'INVALID_INPUT');
}

const pvKey = (f: FieldMeta) => JSON.stringify((f.picklistValues ?? []).filter((p) => p.active).map((p) => [p.value, p.label, p.validFor ?? null]));

export function diffDescribe(before: DescribeSnapshot, after: DescribeSnapshot): DescribeDiff {
  check(before, 'before');
  check(after, 'after');
  const bO = Object.keys(before.objects);
  const aO = Object.keys(after.objects);
  if (!bO.length && !aO.length) throw new EzTestError('diffDescribe: both snapshots are empty', 'INVALID_INPUT');
  const objectNames: Record<string, string[]> = {};
  for (const n of new Set([...bO, ...aO])) {
    const xs = [before.objects[n], after.objects[n]].filter((x): x is SObjectDescribe => !!x).flatMap((d) => [d.name, d.label, d.labelPlural]);
    objectNames[n] = [...new Set(xs)];
  }
  const changes: FieldChange[] = [];
  for (const n of bO.filter((x) => aO.includes(x))) {
    const b = new Map(before.objects[n].fields.map((f) => [f.name, f]));
    const a = new Map(after.objects[n].fields.map((f) => [f.name, f]));
    for (const [name, x] of b) {
      const y = a.get(name);
      if (!y) {
        changes.push({ object: n, field: name, change: 'removed', before: x, detail: `"${x.label}" (${n}.${name}) was removed` });
        continue;
      }
      if (x.label !== y.label) changes.push({ object: n, field: name, change: 'relabeled', before: x, after: y, detail: `${n}.${name} label "${x.label}" became "${y.label}"` });
      if (x.type !== y.type) changes.push({ object: n, field: name, change: 'type-changed', before: x, after: y, detail: `${n}.${name} ("${y.label}") type ${x.type} became ${y.type}` });
      if (x.required !== y.required) {
        changes.push({ object: n, field: name, change: 'required-changed', before: x, after: y, detail: `${n}.${name} ("${y.label}") is ${y.required ? 'now required' : 'no longer required'}` });
      }
      if (pvKey(x) !== pvKey(y)) {
        const bv = new Set((x.picklistValues ?? []).filter((p) => p.active).map((p) => p.value));
        const av = new Set((y.picklistValues ?? []).filter((p) => p.active).map((p) => p.value));
        const removedValues = [...bv].filter((v) => !av.has(v));
        const addedValues = [...av].filter((v) => !bv.has(v));
        const parts = [removedValues.length ? `removed ${removedValues.map((v) => `"${v}"`).join(', ')}` : '', addedValues.length ? `added ${addedValues.map((v) => `"${v}"`).join(', ')}` : '']
          .filter(Boolean).join('; ') || 'labels or dependencies changed';
        changes.push({ object: n, field: name, change: 'picklist-changed', before: x, after: y, removedValues, addedValues, detail: `${n}.${name} ("${y.label}") picklist values changed: ${parts}` });
      }
    }
    for (const [name, y] of a) {
      if (!b.has(name)) changes.push({ object: n, field: name, change: 'added', after: y, detail: `"${y.label}" (${n}.${name}, ${y.type}${y.required ? ', required' : ''}) was added` });
    }
  }
  const of = (k: FieldChangeKind) => changes.filter((c) => c.change === k);
  return {
    before: { takenAt: before.takenAt, ...(before.release ? { release: before.release } : {}) },
    after: { takenAt: after.takenAt, ...(after.release ? { release: after.release } : {}) },
    objects: { added: aO.filter((x) => !bO.includes(x)), removed: bO.filter((x) => !aO.includes(x)) },
    objectNames,
    changes,
    added: of('added'),
    removed: of('removed'),
    relabeled: of('relabeled'),
    typeChanged: of('type-changed'),
    requiredChanged: of('required-changed'),
    picklistChanged: of('picklist-changed'),
  };
}

export interface SalesforceImpactReason {
  stepId: string;
  intent: string;
  object: string;
  field: string;
  change: FieldChangeKind | 'object-removed' | 'picklist-value-removed';
  matchedBy: 'label' | 'api-name' | 'locator' | 'creates-record' | 'picklist-value' | 'object';
  matched: string;
  /** breaking: the step will fail as written; review: likely affected, check it. */
  severity: 'breaking' | 'review';
  detail: string;
}

export interface SalesforceImpactedJourney {
  journeyId: string;
  name: string;
  risk: number;
  breaking: number;
  reasons: SalesforceImpactReason[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (s: string) => new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRe(s).replace(/\s+/g, '\\s+')}(?![A-Za-z0-9_])`, 'i');

/** Field references a step makes explicitly, with the value it uses (if any). */
function fieldRefs(step: Step): Array<{ ref: string; value?: string }> {
  const a = step.args ?? {};
  const out: Array<{ ref: string; value?: string }> = [];
  if (typeof a.field === 'string') out.push({ ref: a.field, ...(typeof a.value === 'string' ? { value: a.value } : {}) });
  if (a.expect && typeof a.expect === 'object') for (const [k, v] of Object.entries(a.expect as Record<string, unknown>)) out.push({ ref: k, value: String(v) });
  return out;
}

function stepTexts(step: Step): { text: string[]; locators: string[] } {
  const text = [step.intent, step.value ?? '', step.target?.description ?? ''];
  const locators = (step.target?.locators ?? []).flatMap((l) => [l.value, l.name ?? '']);
  if (step.postconditions.length) text.push(JSON.stringify(step.postconditions));
  return { text: text.filter(Boolean), locators: locators.filter(Boolean) };
}

const OPENS = new Set(['sf.newRecord', 'sf.openRecord', 'sf.openTab']);
const SCOPED_BY_ARG = new Set(['sf.verifySoql', 'sf.expectListView']);

/**
 * Journeys affected by a describe diff, with reasons. Salesforce steps are
 * scoped to the object of the most recent open/new/tab step (or their own
 * object argument); other steps are matched against any object.
 */
export function impactedJourneys(diff: DescribeDiff, journeys: Journey[]): SalesforceImpactedJourney[] {
  if (!diff || !Array.isArray(diff.changes)) throw new EzTestError('impactedJourneys: not a describe diff', 'INVALID_INPUT');
  if (!journeys.length) throw new EzTestError('impactedJourneys: no journeys given', 'INVALID_INPUT');
  const objectOf = (name: string): string | undefined => {
    const n = normalizeLabel(name);
    return Object.entries(diff.objectNames).find(([, ns]) => ns.some((x) => normalizeLabel(x) === n))?.[0];
  };
  const out: SalesforceImpactedJourney[] = [];
  for (const j of journeys) {
    const reasons: SalesforceImpactReason[] = [];
    let current: string | undefined;
    const created = new Map<string, Step>();
    const setFields = new Map<string, Set<string>>();
    for (const step of j.steps) {
      const h = step.handler ?? '';
      const a = step.args ?? {};
      const argObject = [a.object, a.tab].find((x): x is string => typeof x === 'string');
      const argObj = argObject ? objectOf(argObject) : undefined;
      if (OPENS.has(h)) current = argObj;
      if (h === 'sf.newRecord' && argObj) created.set(argObj, step);
      const scope = SCOPED_BY_ARG.has(h) ? argObj : h.startsWith('sf.') ? current : undefined;
      if (h === 'sf.setField' && current) {
        const s = setFields.get(current) ?? new Set<string>();
        s.add(normalizeLabel(String(a.field ?? '')));
        setFields.set(current, s);
      }
      if (argObject && argObj && diff.objects.removed.includes(argObj)) {
        reasons.push({ stepId: step.id, intent: step.intent, object: argObj, field: '', change: 'object-removed', matchedBy: 'object', matched: argObject, severity: 'breaking', detail: `sObject ${argObj} no longer exists` });
      }
      const refs = fieldRefs(step);
      const refNames = refs.map((r) => normalizeLabel(r.ref));
      const { text, locators } = stepTexts(step);
      for (const c of diff.changes) {
        if (c.change === 'added') continue;
        if (scope && scope !== c.object) continue;
        // Path stage values are checked against removed picklist values below.
        if (h === 'sf.expectPathStage' && c.change === 'picklist-changed') continue;
        const oldLabel = c.before?.label;
        const newLabel = c.after?.label;
        const labels = c.change === 'relabeled' || c.change === 'removed' ? [oldLabel] : [newLabel ?? oldLabel];
        const breaking = c.change === 'removed' || c.change === 'relabeled' || c.change === 'type-changed';
        let hit: Pick<SalesforceImpactReason, 'matchedBy' | 'matched' | 'severity'> | undefined;
        let hitRef: { ref: string; value?: string } | undefined;
        for (const l of labels) {
          if (!l || hit) continue;
          const idx = refNames.indexOf(normalizeLabel(l));
          if (idx >= 0 || text.some((t) => wordRe(l).test(t))) {
            hit = { matchedBy: 'label', matched: l, severity: breaking ? 'breaking' : 'review' };
            if (idx >= 0) hitRef = refs[idx];
          }
        }
        if (!hit) {
          const idx = refNames.indexOf(c.field.toLowerCase());
          if (idx >= 0 || text.some((t) => wordRe(c.field).test(t))) {
            hit = { matchedBy: 'api-name', matched: c.field, severity: c.change === 'removed' || c.change === 'type-changed' ? 'breaking' : 'review' };
            if (idx >= 0) hitRef = refs[idx];
          }
        }
        if (!hit && locators.some((l) => l.includes(`sfdc:RecordField.${c.object}.${c.field}"`) || (oldLabel !== undefined && l.includes(`field-label="${oldLabel}"`)))) {
          hit = { matchedBy: 'locator', matched: c.field, severity: c.change === 'removed' || (c.change === 'relabeled' && !locators.some((l) => l.includes(`sfdc:RecordField.${c.object}.${c.field}"`))) ? 'breaking' : 'review' };
        }
        if (!hit) continue;
        if (c.change === 'picklist-changed') {
          // A removed value used by the step breaks it; other picklist changes only need review.
          const used = hitRef?.value;
          const removed = used !== undefined ? removedValueMatch(c, used) : undefined;
          if (removed) {
            reasons.push({
              stepId: step.id, intent: step.intent, object: c.object, field: c.field, change: 'picklist-value-removed', matchedBy: 'picklist-value', matched: removed, severity: 'breaking',
              detail: `${c.object}.${c.field} ("${c.after?.label ?? c.field}") no longer has the value "${removed}"`,
            });
            continue;
          }
        }
        reasons.push({ stepId: step.id, intent: step.intent, object: c.object, field: c.field, change: c.change, ...hit, detail: c.detail });
      }
      // Path stages: a stage value the release removed from a picklist of the current object.
      if (h === 'sf.expectPathStage' && typeof a.stage === 'string') {
        for (const c of diff.picklistChanged.filter((x) => !scope || x.object === scope)) {
          const removed = removedValueMatch(c, a.stage);
          if (removed) {
            reasons.push({
              stepId: step.id, intent: step.intent, object: c.object, field: c.field, change: 'picklist-value-removed', matchedBy: 'picklist-value', matched: removed, severity: 'breaking',
              detail: `${c.object}.${c.field} ("${c.after?.label ?? c.field}") no longer has the stage "${removed}"`,
            });
          }
        }
      }
    }
    // Newly required fields break journeys that create records of that object without setting them.
    for (const c of diff.changes) {
      const nowRequired = (c.change === 'required-changed' || c.change === 'added') && c.after?.required === true && c.before?.required !== true;
      const step = created.get(c.object);
      if (!nowRequired || !step) continue;
      const set = setFields.get(c.object) ?? new Set();
      const label = c.after?.label;
      if (set.has(c.field.toLowerCase()) || (label && set.has(normalizeLabel(label)))) continue;
      reasons.push({
        stepId: step.id, intent: step.intent, object: c.object, field: c.field, change: c.change, matchedBy: 'creates-record', matched: label ?? c.field, severity: 'breaking',
        detail: `"${label ?? c.field}" is now required on ${c.object}; this journey creates a ${c.object} without setting it`,
      });
    }
    if (reasons.length) out.push({ journeyId: j.id, name: j.name, risk: j.risk, breaking: reasons.filter((r) => r.severity === 'breaking').length, reasons });
  }
  return out.sort((a, b) => b.breaking - a.breaking || b.risk - a.risk || a.journeyId.localeCompare(b.journeyId));
}

/** The removed picklist value (API name) a user-written value refers to, by value or old label. */
function removedValueMatch(c: FieldChange, used: string): string | undefined {
  const n = normalizeLabel(used);
  for (const v of c.removedValues ?? []) {
    const label = c.before?.picklistValues?.find((p) => p.value === v)?.label;
    if (normalizeLabel(v) === n || (label && normalizeLabel(label) === n)) return v;
  }
  return undefined;
}
