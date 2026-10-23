/**
 * Change impact for packaged apps: "which journeys does this change break".
 *
 * Every pack turns its own change source into a list of AppChange records:
 * SAP transports (E071 object lists), ServiceNow update sets and upgrade
 * skipped records, Workday tenant-preview snapshots and What's New reports,
 * Oracle quarterly-update snapshots, Power Apps app versions. Metadata
 * snapshots of two tenants/releases diff into the same records. A pack-specific
 * scoper says, for every step of a journey, which objects (tables, entity
 * sets, transactions, apps, tasks) and fields it touches; the matcher below
 * then lists the affected journeys with a reason per step.
 */
import { EzTestError, nowIso, type Journey, type Step } from '../../core/index.js';
import { escapeRe, normalizeLabel, walkSteps, type PackId } from './kit.js';

export type AppChangeKind =
  | 'object-removed' | 'object-changed'
  | 'field-added' | 'field-removed' | 'field-relabeled' | 'field-type-changed' | 'field-required' | 'field-optional' | 'field-readonly'
  | 'values-removed' | 'values-added'
  | 'ui-changed' | 'logic-changed' | 'security-changed' | 'skipped-upgrade';

export interface AppChange {
  pack: PackId;
  kind: AppChangeKind;
  /** Canonical object key: entity set, table, transaction, app id, business object. */
  object: string;
  /** Every name the object is known by (labels, tcodes, app ids, service names). */
  objectNames: string[];
  /** Canonical field key (property, column, element), when the change is field-level. */
  field?: string;
  /** Every name the field is known by before and after (labels, technical names). */
  fieldNames?: string[];
  /** Removed or added values (picklist / choice / domain fixed values). */
  values?: string[];
  severity: 'breaking' | 'review';
  /** Field names whose use makes the change breaking (e.g. only the OLD label of a relabeled field); other matches are review. */
  breakingNames?: string[];
  /** Field names that match in any object (globally unique technical names such as SAP GUI's VBKD-BSTKD); other names need the object. */
  anyObjectNames?: string[];
  /** Where the change comes from: "transport DEVK900123", "update set ...", "2026R2 preview". */
  source: string;
  detail: string;
}

/** What a step touches, from the pack's point of view. */
export interface StepScope {
  /** Object names this step works on (empty: any object, matched by text only). */
  objects: string[];
  /** Field references with the value the step uses. */
  fields: Array<{ ref: string; value?: string }>;
  /** Creates a record of this object (for newly-required fields). */
  creates?: string;
  /** Free text to search for names (intent, value). */
  texts: string[];
}

/** Pack hook: the scope of a step, given the scope carried from earlier steps of the journey (e.g. the open app). */
export type StepScoper = (step: Step, current: { objects: string[] }) => { scope?: StepScope; carry?: string[] };

export interface ImpactReason {
  stepId: string;
  intent: string;
  object: string;
  field?: string;
  change: AppChangeKind;
  matchedBy: 'object' | 'field' | 'value' | 'creates-record' | 'text';
  matched: string;
  severity: 'breaking' | 'review';
  source: string;
  detail: string;
}

export interface ImpactedJourney {
  journeyId: string;
  name: string;
  risk: number;
  breaking: number;
  reasons: ImpactReason[];
}

export interface ImpactReport {
  schema: 'eztest.apps.impact/v1';
  pack: PackId;
  generatedAt: string;
  sources: string[];
  changes: AppChange[];
  impacted: ImpactedJourney[];
  /** Changes no journey touches (test gaps to review). */
  untested: AppChange[];
}

const wordRe = (s: string) => new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRe(s).replace(/\s+/g, '\\s+')}(?![A-Za-z0-9_])`, 'i');

const FIELD_BREAKING = new Set<AppChangeKind>(['field-removed', 'field-relabeled', 'field-type-changed', 'field-readonly']);

/** Exact (normalised) name match; a trailing "*" in a known name matches by prefix (VBAK-* matches VBAK-AUART). */
function hasName(names: string[], x: string): boolean {
  const n = normalizeLabel(x);
  return names.some((y) => {
    const k = normalizeLabel(y);
    return k.endsWith('*') ? n.startsWith(k.slice(0, -1)) && n.length > k.length - 1 : k === n;
  });
}

/** Match changes against journeys. */
export function impactedJourneys(changes: AppChange[], journeys: Journey[], scoper: StepScoper): { impacted: ImpactedJourney[]; untested: AppChange[] } {
  if (!Array.isArray(changes)) throw new EzTestError('impactedJourneys: changes must be a list', 'INVALID_INPUT');
  const touched = new Set<AppChange>();
  const out: ImpactedJourney[] = [];
  for (const j of journeys) {
    const reasons: ImpactReason[] = [];
    let current: string[] = [];
    const created = new Map<string, Step>();
    const setFields = new Map<string, Set<string>>();
    const steps = [...walkSteps(j.steps)];
    const push = (step: Step, c: AppChange, r: Pick<ImpactReason, 'matchedBy' | 'matched' | 'severity'>) => {
      touched.add(c);
      // Field-level changes are reported per step; object-level ones (logic, layout, removal) once per journey.
      if (reasons.some((x) => (c.field ? x.stepId === step.id : true) && x.object === c.object && x.field === c.field && x.change === c.kind && x.detail === c.detail)) return;
      reasons.push({ stepId: step.id, intent: step.intent, object: c.object, ...(c.field ? { field: c.field } : {}), change: c.kind, ...r, source: c.source, detail: c.detail });
    };
    for (const step of steps) {
      const { scope, carry } = scoper(step, { objects: current });
      if (carry) current = carry;
      if (!scope) continue;
      if (scope.creates) {
        created.set(normalizeLabel(scope.creates), step);
      }
      for (const o of scope.objects) {
        const s = setFields.get(normalizeLabel(o)) ?? new Set<string>();
        for (const f of scope.fields) s.add(normalizeLabel(f.ref));
        setFields.set(normalizeLabel(o), s);
      }
      for (const c of changes) {
        const objHit = scope.objects.some((o) => hasName(c.objectNames, o) || normalizeLabel(o) === normalizeLabel(c.object));
        const globalHit = !!c.field && !!c.anyObjectNames && scope.fields.some((f) => hasName(c.anyObjectNames!, f.ref));
        if (scope.objects.length && !objHit && !globalHit) continue;
        if (!c.field) {
          // Object-level change: a step working on that object (or naming it) is affected.
          if (objHit) push(step, c, { matchedBy: 'object', matched: scope.objects.find((o) => hasName(c.objectNames, o) || normalizeLabel(o) === normalizeLabel(c.object))!, severity: c.severity });
          else {
            const n = c.objectNames.find((x) => x.length > 2 && scope.texts.some((t) => wordRe(x).test(t)));
            if (n) push(step, c, { matchedBy: 'text', matched: n, severity: 'review' });
          }
          continue;
        }
        if (c.kind === 'field-added' || c.kind === 'field-required' || c.kind === 'values-added') {
          // Only affects journeys through the "creates a record" rule below (or a value-level check).
          continue;
        }
        const names = c.fieldNames ?? [c.field];
        const ref = scope.fields.find((f) => hasName(names, f.ref));
        if (ref) {
          if (c.kind === 'values-removed') {
            if (ref.value !== undefined && hasName(c.values ?? [], ref.value)) push(step, c, { matchedBy: 'value', matched: ref.value, severity: 'breaking' });
            else push(step, c, { matchedBy: 'field', matched: ref.ref, severity: 'review' });
          } else {
            const strong = FIELD_BREAKING.has(c.kind) || c.kind === 'ui-changed' || c.kind === 'object-removed' || c.kind === 'logic-changed';
            const byName = c.breakingNames ? hasName(c.breakingNames, ref.ref) : true;
            push(step, c, { matchedBy: 'field', matched: ref.ref, severity: strong && byName ? c.severity : 'review' });
          }
          continue;
        }
        const n = names.find((x) => x.length > 2 && scope.texts.some((t) => wordRe(x).test(t)));
        if (n && objHit) push(step, c, { matchedBy: 'text', matched: n, severity: 'review' });
      }
    }
    // Newly required fields break journeys that create a record of that object without setting the field.
    for (const c of changes) {
      if (c.kind !== 'field-required' && !(c.kind === 'field-added' && c.severity === 'breaking')) continue;
      const key = [c.object, ...c.objectNames].map(normalizeLabel).find((k) => created.has(k));
      if (!key) continue;
      const step = created.get(key)!;
      const set = setFields.get(key) ?? new Set<string>();
      if ((c.fieldNames ?? [c.field ?? '']).some((n) => set.has(normalizeLabel(n)))) continue;
      push(step, c, { matchedBy: 'creates-record', matched: c.fieldNames?.[0] ?? c.field ?? '', severity: 'breaking' });
    }
    if (reasons.length) out.push({ journeyId: j.id, name: j.name, risk: j.risk, breaking: reasons.filter((r) => r.severity === 'breaking').length, reasons });
  }
  out.sort((a, b) => b.breaking - a.breaking || b.risk - a.risk || a.journeyId.localeCompare(b.journeyId));
  return { impacted: out, untested: changes.filter((c) => !touched.has(c)) };
}

export function impactReport(pack: PackId, changes: AppChange[], journeys: Journey[], scoper: StepScoper): ImpactReport {
  const { impacted, untested } = impactedJourneys(changes, journeys, scoper);
  return { schema: 'eztest.apps.impact/v1', pack, generatedAt: nowIso(), sources: [...new Set(changes.map((c) => c.source))], changes, impacted, untested };
}

// ---------------------------------------------------------------- metadata snapshots

export interface AppFieldMeta {
  /** Technical name (OData property, column, element, attribute). */
  name: string;
  label: string;
  type: string;
  required?: boolean;
  readOnly?: boolean;
  /** Allowed values (choices, domain fixed values, LOV codes). */
  values?: string[];
  /** Further names users write (e.g. SAP GUI technical names VBAK-AUART). */
  aliases?: string[];
}

export interface AppObjectMeta {
  name: string;
  label: string;
  /** Other names: plural label, transaction codes, app ids, service names. */
  aliases?: string[];
  fields: AppFieldMeta[];
}

export interface AppSnapshot {
  schema: 'eztest.apps.snapshot/v1';
  pack: PackId;
  takenAt: string;
  source?: string;
  /** Release / update label, e.g. "2026R1", "25D", "transport DEVK900123". */
  release?: string;
  objects: Record<string, AppObjectMeta>;
}

export function makeSnapshot(pack: PackId, objects: AppObjectMeta[], o: { source?: string; release?: string } = {}): AppSnapshot {
  const out: AppSnapshot = { schema: 'eztest.apps.snapshot/v1', pack, takenAt: nowIso(), objects: {} };
  if (o.source) out.source = o.source;
  if (o.release) out.release = o.release;
  for (const ob of objects) out.objects[ob.name] = { ...ob, fields: [...ob.fields].sort((a, b) => a.name.localeCompare(b.name)) };
  return out;
}

function checkSnapshot(s: AppSnapshot, which: string, pack?: PackId): void {
  if (!s || s.schema !== 'eztest.apps.snapshot/v1' || !s.objects) throw new EzTestError(`diffSnapshots: ${which} is not an EZTest app snapshot`, 'INVALID_INPUT');
  if (pack && s.pack !== pack) throw new EzTestError(`diffSnapshots: ${which} is a ${s.pack} snapshot, expected ${pack}`, 'INVALID_INPUT');
}

/** Diff two snapshots of the same pack into AppChange records. */
export function diffSnapshots(before: AppSnapshot, after: AppSnapshot, o: { source?: string } = {}): AppChange[] {
  checkSnapshot(before, 'before');
  checkSnapshot(after, 'after', before.pack);
  const pack = before.pack;
  const source = o.source ?? `${before.release ?? before.takenAt} -> ${after.release ?? after.takenAt}`;
  const out: AppChange[] = [];
  const objNames = (n: string) => {
    const xs = [before.objects[n], after.objects[n]].filter((x): x is AppObjectMeta => !!x).flatMap((x) => [x.name, x.label, ...(x.aliases ?? [])]);
    return [...new Set(xs.filter(Boolean))];
  };
  for (const n of Object.keys(before.objects)) {
    if (!after.objects[n]) {
      out.push({ pack, kind: 'object-removed', object: n, objectNames: objNames(n), severity: 'breaking', source, detail: `${before.objects[n].label} (${n}) no longer exists` });
      continue;
    }
    const b = new Map(before.objects[n].fields.map((f) => [f.name, f]));
    const a = new Map(after.objects[n].fields.map((f) => [f.name, f]));
    const names = (x?: AppFieldMeta, y?: AppFieldMeta) => [...new Set([x?.name, x?.label, y?.label, ...(x?.aliases ?? []), ...(y?.aliases ?? [])].filter((s): s is string => !!s))];
    const base = (f: string, x?: AppFieldMeta, y?: AppFieldMeta) => ({ pack, object: n, objectNames: objNames(n), field: f, fieldNames: names(x, y), source });
    for (const [f, x] of b) {
      const y = a.get(f);
      if (!y) {
        out.push({ ...base(f, x), kind: 'field-removed', severity: 'breaking', detail: `"${x.label}" (${n}.${f}) was removed` });
        continue;
      }
      if (x.label !== y.label) out.push({ ...base(f, x, y), kind: 'field-relabeled', severity: 'breaking', breakingNames: [x.label], detail: `${n}.${f} label "${x.label}" became "${y.label}"` });
      if (x.type !== y.type) out.push({ ...base(f, x, y), kind: 'field-type-changed', severity: 'breaking', detail: `${n}.${f} ("${y.label}") type ${x.type} became ${y.type}` });
      if (!x.required && y.required) out.push({ ...base(f, x, y), kind: 'field-required', severity: 'breaking', detail: `${n}.${f} ("${y.label}") is now required` });
      if (x.required && !y.required) out.push({ ...base(f, x, y), kind: 'field-optional', severity: 'review', detail: `${n}.${f} ("${y.label}") is no longer required` });
      if (!x.readOnly && y.readOnly) out.push({ ...base(f, x, y), kind: 'field-readonly', severity: 'breaking', detail: `${n}.${f} ("${y.label}") became read-only` });
      const bv = new Set(x.values ?? []);
      const av = new Set(y.values ?? []);
      const removed = [...bv].filter((v) => !av.has(v));
      const added = [...av].filter((v) => !bv.has(v));
      if (removed.length) out.push({ ...base(f, x, y), kind: 'values-removed', values: removed, severity: 'breaking', detail: `${n}.${f} ("${y.label}") lost values ${removed.map((v) => `"${v}"`).join(', ')}` });
      if (added.length) out.push({ ...base(f, x, y), kind: 'values-added', values: added, severity: 'review', detail: `${n}.${f} ("${y.label}") gained values ${added.map((v) => `"${v}"`).join(', ')}` });
    }
    for (const [f, y] of a) {
      if (b.has(f)) continue;
      out.push({ ...base(f, undefined, y), kind: 'field-added', severity: y.required ? 'breaking' : 'review', detail: `"${y.label}" (${n}.${f}, ${y.type}${y.required ? ', required' : ''}) was added` });
    }
  }
  return out;
}
