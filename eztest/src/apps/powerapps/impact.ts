/**
 * Power Apps canvas change impact.
 *
 *  - App versions: the app's Power Apps source (.pa.yaml from
 *    `pac canvas unpack` / source control) is parsed into screens and
 *    controls with their formulas. Two versions diff into removed, added,
 *    renamed (same control type and formulas under a new name), retyped and
 *    re-formulated controls; journeys name controls, so a rename breaks them.
 *  - Dataverse: release-wave metadata diffs from the D365 add-on
 *    (snapshotMetadata/diffMetadata, reused) are mapped onto the controls
 *    whose formulas use the changed column, and onto Patch() calls that do
 *    not set a newly required column.
 */
import { parse as parseYaml } from 'yaml';
import type { Step } from '../../core/index.js';
import type { MetadataDiff } from '../../d365/index.js';
import { EzTestError } from '../../core/index.js';
import { makeSnapshot, type AppChange, type AppFieldMeta, type AppSnapshot, type StepScoper } from '../common/impact.js';
import { escapeRe } from '../common/kit.js';
import { powerFxNames } from './powerfx.js';

export interface CanvasSourceControl { name: string; type: string; screen: string; parent?: string; formulas: Record<string, string> }
export interface CanvasSource { app: string; version?: string; dataSources: Record<string, string>; screens: string[]; controls: CanvasSourceControl[] }

type Y = Record<string, unknown>;

/** Parse Power Apps source YAML (App / DataSources / Screens -> Children -> - name: { Control, Properties, Children }). */
export function parseCanvasSource(yamlText: string): CanvasSource {
  const doc = parseYaml(yamlText) as Y;
  if (!doc || typeof doc !== 'object' || !doc.Screens) throw new EzTestError('Not Power Apps source YAML (no Screens)', 'PA_BAD_SOURCE');
  const appProps = ((doc.App as Y | undefined)?.Properties ?? {}) as Y;
  const app = String(appProps.Name ?? 'App').replace(/^=?"?|"?$/g, '');
  const dataSources: Record<string, string> = {};
  for (const [n, d] of Object.entries((doc.DataSources ?? {}) as Y)) dataSources[n] = String(((d as Y)?.Parameters as Y | undefined)?.TableLogicalName ?? n);
  const controls: CanvasSourceControl[] = [];
  const walk = (children: unknown, screen: string, parent?: string) => {
    for (const item of Array.isArray(children) ? children : []) {
      for (const [name, def] of Object.entries((item ?? {}) as Y)) {
        const d = (def ?? {}) as Y;
        const formulas = Object.fromEntries(Object.entries((d.Properties ?? {}) as Y).map(([k, v]) => [k, String(v)]));
        controls.push({ name, type: String(d.Control ?? '').split('@')[0], screen, ...(parent ? { parent } : {}), formulas });
        walk(d.Children, screen, name);
      }
    }
  };
  const screens = Object.keys(doc.Screens as Y);
  for (const [s, def] of Object.entries(doc.Screens as Y)) walk(((def ?? {}) as Y).Children, s);
  return { app, version: appProps.Version ? String(appProps.Version) : undefined, dataSources, screens, controls };
}

const staticText = (f?: string) => (f && /^="(?:[^"]|"")*"$/.test(f.trim()) ? f.trim().slice(2, -1).replace(/""/g, '"') : undefined);

/** Snapshot an app version: one object per app with screens and controls as fields. */
export function snapshotCanvasApp(src: CanvasSource, o: { release?: string; source?: string } = {}): AppSnapshot {
  const fields: AppFieldMeta[] = [
    ...src.screens.map((s) => ({ name: s, label: s, type: 'Screen', aliases: [s] })),
    ...src.controls.map((c) => ({ name: c.name, label: staticText(c.formulas.Text) ?? c.name, type: c.type, aliases: [c.name] })),
  ];
  return makeSnapshot('powerapps', [{ name: `app:${src.app}`, label: src.app, aliases: [src.app, ...Object.keys(src.dataSources)], fields }], { release: o.release ?? src.version, source: o.source });
}

/** A control's formulas with every control name replaced, to recognise a renamed control. */
function signature(c: CanvasSourceControl, names: Set<string>): string {
  return Object.entries(c.formulas).filter(([k]) => k !== 'Text').map(([k, v]) => `${k}${[...names].reduce((s, n) => s.replace(new RegExp(`\\b${escapeRe(n)}\\b`, 'g'), '#'), v)}`).sort().join('|');
}

/** Diff two app versions. */
export function canvasAppChanges(before: CanvasSource, after: CanvasSource, o: { source?: string } = {}): AppChange[] {
  const source = o.source ?? `app ${before.app} ${before.version ?? 'before'} -> ${after.version ?? 'after'}`;
  const obj = { pack: 'powerapps' as const, object: `app:${after.app}`, objectNames: [before.app, after.app, `app:${before.app}`], source };
  const b = new Map(before.controls.map((c) => [c.name, c]));
  const a = new Map(after.controls.map((c) => [c.name, c]));
  const allNames = new Set([...b.keys(), ...a.keys()]);
  const removed = [...b.values()].filter((c) => !a.has(c.name));
  const added = [...a.values()].filter((c) => !b.has(c.name));
  const out: AppChange[] = [];
  const used = new Set<string>();
  for (const r of removed) {
    const twin = added.find((x) => !used.has(x.name) && x.type === r.type && x.screen === r.screen && signature(x, allNames) === signature(r, allNames));
    if (twin) {
      used.add(twin.name);
      out.push({ ...obj, kind: 'field-relabeled', field: r.name, fieldNames: [r.name, twin.name], breakingNames: [r.name], severity: 'breaking', detail: `control ${r.name} (${r.type}) on ${r.screen} is renamed ${twin.name}` });
      continue;
    }
    const replaced = added.find((x) => !used.has(x.name) && x.screen === r.screen && x.type !== r.type && x.formulas.Items === r.formulas.Items && r.formulas.Items !== undefined);
    out.push({ ...obj, kind: 'field-removed', field: r.name, fieldNames: [r.name], severity: 'breaking', detail: `control ${r.name} (${r.type}) is removed from ${r.screen}${replaced ? `; ${replaced.name} (${replaced.type}) looks like its replacement` : ''}` });
  }
  for (const x of added.filter((c) => !used.has(c.name))) out.push({ ...obj, kind: 'field-added', field: x.name, fieldNames: [x.name], severity: 'review', detail: `control ${x.name} (${x.type}) is added to ${x.screen}` });
  for (const [n, x] of b) {
    const y = a.get(n);
    if (!y) continue;
    if (x.type !== y.type) out.push({ ...obj, kind: 'field-type-changed', field: n, fieldNames: [n], severity: 'breaking', detail: `control ${n} changes from ${x.type} to ${y.type}` });
    const tx = staticText(x.formulas.Text);
    const ty = staticText(y.formulas.Text);
    if (tx !== ty && (tx !== undefined || ty !== undefined)) out.push({ ...obj, kind: 'ui-changed', field: n, fieldNames: [n], severity: 'review', detail: `${n}.Text changes from "${tx ?? x.formulas.Text}" to "${ty ?? y.formulas.Text}"` });
    for (const p of new Set([...Object.keys(x.formulas), ...Object.keys(y.formulas)])) {
      if (p === 'Text' || x.formulas[p] === y.formulas[p]) continue;
      out.push({ ...obj, kind: 'logic-changed', field: n, fieldNames: [n], severity: 'review', detail: `${n}.${p} changes from ${x.formulas[p] ?? '(none)'} to ${y.formulas[p] ?? '(none)'}` });
    }
  }
  for (const s of before.screens.filter((s) => !after.screens.includes(s))) out.push({ ...obj, kind: 'field-removed', field: s, fieldNames: [s], severity: 'breaking', detail: `screen ${s} is removed` });
  return out;
}

const mentions = (formula: string, names: string[]) => names.some((n) => n && new RegExp(`(?:'${escapeRe(n)}'|\\b${escapeRe(n)}\\b)`, 'i').test(formula));

/** Map a Dataverse metadata diff (D365 add-on) onto the app's controls. */
export function dataverseChangesForApp(diff: MetadataDiff, src: CanvasSource): AppChange[] {
  const out: AppChange[] = [];
  const dsFor = (entity: string) => Object.entries(src.dataSources).filter(([, t]) => t === entity).map(([n]) => n);
  for (const c of diff.changes) {
    const ds = dsFor(c.entity);
    if (!ds.length) continue;
    const names = [c.logicalName, c.before?.displayName, c.after?.displayName].filter((x): x is string => !!x);
    const base = { pack: 'powerapps' as const, object: `app:${src.app}`, objectNames: [src.app, `app:${src.app}`, c.entity, ...ds], source: `Dataverse ${c.entity}: ${c.detail}` };
    if (c.change === 'removed' || c.change === 'type-changed') {
      for (const ctl of src.controls.filter((x) => Object.values(x.formulas).some((f) => mentions(f, names)))) {
        out.push({ ...base, kind: 'logic-changed', field: ctl.name, fieldNames: [ctl.name], severity: 'breaking', detail: `${ctl.name} uses ${c.entity}.${c.logicalName} ("${names[1] ?? c.logicalName}"), which is ${c.change === 'removed' ? 'removed' : 'retyped'}` });
      }
    } else if (c.change === 'relabeled') {
      for (const ctl of src.controls.filter((x) => Object.values(x.formulas).some((f) => mentions(f, names)))) {
        out.push({ ...base, kind: 'logic-changed', field: ctl.name, fieldNames: [ctl.name], severity: 'review', detail: `${ctl.name} shows ${c.entity}.${c.logicalName}, relabeled "${c.before?.displayName}" -> "${c.after?.displayName}" (formulas follow the logical name; texts and screenshots change)` });
      }
    } else if ((c.change === 'required-changed' || c.change === 'added') && /Required$/.test(c.after?.requiredLevel ?? '') && !/Required$/.test(c.before?.requiredLevel ?? '')) {
      for (const ctl of src.controls.filter((x) => Object.values(x.formulas).some((f) => ds.some((d) => new RegExp(`\\bPatch\\(\\s*${escapeRe(d)}\\b`, 'i').test(f)) && !mentions(f, names)))) {
        out.push({ ...base, kind: 'logic-changed', field: ctl.name, fieldNames: [ctl.name], severity: 'breaking', detail: `${ctl.name} patches ${c.entity} without "${c.after?.displayName ?? c.logicalName}", which is now required` });
      }
    }
  }
  return out;
}

/** What a Power Apps step touches. */
export function powerAppsScoper(apps: string[]): StepScoper {
  return (step: Step, cur) => {
    const h = step.handler ?? '';
    const a = step.args ?? {};
    const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
    const texts = [step.intent].filter(Boolean);
    if (h === 'pa.openApp') {
      const app = s('app')!;
      return { carry: [app, `app:${app}`], scope: { objects: [app, `app:${app}`], fields: [], texts } };
    }
    const objs = cur.objects.length ? cur.objects : apps.flatMap((x) => [x, `app:${x}`]);
    if (['pa.setControl', 'pa.select', 'pa.expectProperty', 'pa.expectState'].includes(h)) return { scope: { objects: objs, fields: [{ ref: s('control')!, ...(s('value') !== undefined ? { value: s('value') } : {}) }], texts } };
    if (h === 'pa.selectItem') return { scope: { objects: objs, fields: [{ ref: s('gallery')! }, ...((a.where as { control?: string } | undefined)?.control ? [{ ref: (a.where as { control: string }).control }] : [])], texts } };
    if (h === 'pa.expectGallery') return { scope: { objects: objs, fields: [{ ref: s('gallery')! }], texts } };
    if (h === 'pa.expectScreen') return { scope: { objects: objs, fields: [{ ref: s('screen')! }], texts } };
    if (h === 'pa.expectPowerFx') {
      let names: string[] = [];
      try {
        names = powerFxNames(s('expression') ?? '');
      } catch {
        names = [];
      }
      return { scope: { objects: objs, fields: names.map((ref) => ({ ref })), texts } };
    }
    if (h === 'd365.verifyDataverse') return { scope: { objects: [s('entity')!], fields: Object.entries((a.expect as Record<string, unknown>) ?? {}).map(([ref, v]) => ({ ref, value: String(v) })), texts } };
    if (h.startsWith('pa.')) return { scope: { objects: objs, fields: [], texts } };
    return {};
  };
}


