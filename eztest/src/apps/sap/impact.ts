/**
 * SAP change impact from transports (G33).
 *
 * A transport request's object list (ADT, or an E071 export) is mapped to
 * what journeys use:
 *
 *   R3TR TRAN VA01                -> SAP GUI journeys running VA01 (and Fiori apps sharing it)
 *   R3TR PROG / LIMU REPS ...     -> the transactions and apps of that program (object map)
 *   R3TR TABL / TABU / VIEW T     -> GUI fields T-*, the transactions and entity sets of T
 *   R3TR DTEL / DOMA D            -> the fields typed with D (labels compared between systems)
 *   R3TR IWSV / SRVB / SRVD / DDLS -> the OData service's entity sets (metadata compared)
 *   R3TR WAPA app                 -> the Fiori app deployed from that BSP repository
 *   R3TR ACGR role                -> security review for the mapped apps
 *
 * With a source system (e.g. DEV, where the transport lives) and the test
 * system (e.g. QAS), the configured OData services are snapshotted in both and
 * the precise differences (relabeled, newly mandatory, removed values) are
 * attributed to the transport objects that cause them — the
 * LiveCompare/Worksoft Impact style analysis. Objects the map cannot place are
 * reported as unmapped review items.
 */
import type { Step } from '../../core/index.js';
import { diffSnapshots, makeSnapshot, type AppChange, type AppFieldMeta, type AppSnapshot, type StepScoper } from '../common/impact.js';
import { normalizeLabel } from '../common/kit.js';
import type { SapODataClient, Transport, TransportObject } from './odata.js';
import type { FioriApp } from './steps.js';

/** A starting map for standard SD/MM objects (extend or override with sap.objectMap). */
export const BUILTIN_OBJECT_MAP: Record<string, string[]> = {
  'PROG SAPMV45A': ['VA01', 'VA02', 'VA03'],
  'REPS MV45AFZZ': ['VA01', 'VA02', 'VA03'],
  'TABL VBAK': ['VBAK-*', 'VA01', 'VA02', 'VA03', 'A_SalesOrder', 'C_SalesOrder'],
  'TABL VBAP': ['VBAP-*', 'VA01', 'VA02', 'VA03', 'A_SalesOrderItem'],
  'TABL VBKD': ['VBKD-*', 'VA01', 'VA02', 'VA03'],
  'DTEL BSTKD': ['VBKD-BSTKD', 'A_SalesOrder.PurchaseOrderByCustomer', 'C_SalesOrder.PurchaseOrderByCustomer'],
  'DTEL AUART': ['VBAK-AUART', 'A_SalesOrder.SalesOrderType', 'C_SalesOrder.SalesOrderType'],
  'TABU TVAK': ['VBAK-AUART', 'A_SalesOrder.SalesOrderType', 'C_SalesOrder.SalesOrderType'],
  'TABL MARA': ['MARA-*', 'MM01', 'MM02', 'MM03', 'A_Product', 'Product'],
  'DTEL MATKL': ['MARA-MATKL', 'A_Product.ProductGroup', 'Product.ProductGroup'],
  'PROG SAPLMEGUI': ['ME21N', 'ME22N', 'ME23N'],
  'TABL EKKO': ['EKKO-*', 'ME21N', 'ME22N', 'ME23N', 'A_PurchaseOrder'],
};

export interface SapImpactContext {
  apps: FioriApp[];
  objectMap?: Record<string, string[]>;
}

/** Transport mapping context: apps, the object map and the configured services' entity sets. */
export interface SapTransportContext extends SapImpactContext {
  entitySets: string[];
  services: string[];
  entitySetsOf(service: string): string[];
}

const appNames = (a: FioriApp) => [a.title, ...(a.intent ? [a.intent] : []), ...(a.ui5App ? [a.ui5App] : []), `app:${a.title}`];

/** Names an entity set is known by in journeys: its name, label, service and the apps (with their tcodes) built on it. */
function setNames(ctx: SapImpactContext, set: string, label?: string, service?: string): string[] {
  const apps = ctx.apps.filter((a) => a.entitySet === set);
  return [...new Set([set, ...(label ? [label] : []), ...(service ? [service] : []), ...apps.flatMap((a) => [...appNames(a), ...(a.tcodes ?? [])])])];
}

/** Snapshot the configured OData services (labels, types, required, value-list values). */
export async function snapshotSap(client: SapODataClient, ctx: SapImpactContext, o: { release?: string; source?: string } = {}): Promise<AppSnapshot> {
  const map = { ...BUILTIN_OBJECT_MAP, ...(ctx.objectMap ?? {}) };
  const guiAliases = (set: string, prop: string) => Object.values(map).filter((ts) => ts.includes(`${set}.${prop}`)).flatMap((ts) => ts.filter((t) => /^[A-Z0-9_/]+-[A-Z0-9_/]+$/.test(t)));
  const objs = [];
  for (const s of client.services) {
    const md = await client.metadata(s.name);
    for (const es of Object.values(md.entitySets)) {
      const fields: AppFieldMeta[] = [];
      for (const p of es.properties) {
        const values = p.valueList?.fixed ? (await client.valueList(s.name, es.name, p.name).catch(() => [])).flatMap((v) => [v.key, v.text]) : undefined;
        fields.push({ name: p.name, label: p.label, type: p.type, required: p.required, readOnly: !p.creatable && !p.updatable, ...(values?.length ? { values } : {}), aliases: [p.name, ...guiAliases(es.name, p.name)] });
      }
      objs.push({ name: es.name, label: es.label, aliases: setNames(ctx, es.name, es.label, s.name).filter((x) => x !== es.name), fields });
    }
  }
  return makeSnapshot('sap', objs, { source: o.source ?? client.url, release: o.release });
}

const TCODE = /^[A-Z][A-Z0-9_/]{1,19}$/;
const GUI_FIELD = /^[A-Z0-9_/]+-(?:[A-Z0-9_/]+|\*)$/;

/**
 * AppChanges for one or more transports. `diff` is the snapshot diff between
 * the test system and the source system (optional); `labels` gives data
 * element labels before/after (optional, from ADT in both systems).
 */
export function transportChanges(
  transports: Transport[],
  ctx: SapTransportContext,
  o: { diff?: AppChange[]; labels?: Record<string, { before?: string[]; after?: string[] }> } = {},
): { changes: AppChange[]; unattributed: AppChange[] } {
  const map = { ...BUILTIN_OBJECT_MAP, ...(ctx.objectMap ?? {}) };
  const out: AppChange[] = [];
  const diff = o.diff ?? [];
  const used = new Set<AppChange>();
  for (const tr of transports) {
    for (const obj of tr.objects) {
      const source = `transport ${tr.number}${tr.description ? ` ("${tr.description}")` : ''}: ${obj.pgmid} ${obj.type} ${obj.name}`;
      const targets = targetsOf(obj, map, ctx);
      const before = out.length;
      const emit = (c: Omit<AppChange, 'pack' | 'source'>) => out.push({ pack: 'sap', source, ...c });
      for (const t of targets) {
        if (GUI_FIELD.test(t)) {
          const l = obj.type === 'DTEL' ? o.labels?.[obj.name] : undefined;
          // Transactions working on the field's table (from the map), so label references match only there.
          const tcodes = (map[`TABL ${t.split('-')[0]}`] ?? []).filter((x) => TCODE.test(x) && !ctx.entitySets.includes(x));
          const gui = { object: t.split('-')[0], objectNames: tcodes, anyObjectNames: [t] };
          const relabeled = l?.before?.length && l.after?.length && normalizeLabel(l.before[l.before.length - 1]) !== normalizeLabel(l.after[l.after.length - 1]);
          if (relabeled) {
            emit({ kind: 'field-relabeled', ...gui, field: t, fieldNames: [t, ...l!.before!, ...l!.after!], breakingNames: l!.before, severity: 'breaking', detail: `data element ${obj.name} field labels change from "${l!.before!.at(-1)}" to "${l!.after!.at(-1)}" (SAP GUI field ${t})` });
          } else {
            const keys = (obj.keys ?? []).filter((k) => k.action === 'D').map((k) => k.key.slice(3));
            if (keys.length) emit({ kind: 'values-removed', ...gui, field: t, fieldNames: [t], values: keys, severity: 'breaking', detail: `${obj.type} ${obj.name} deletes entries ${keys.join(', ')} used by ${t}` });
            else emit({ kind: 'logic-changed', ...gui, field: t, fieldNames: [t], severity: 'review', detail: `${obj.type} ${obj.name} changes ${t}` });
          }
          continue;
        }
        const dot = /^(\w+)\.(\w+)$/.exec(t);
        if (dot) {
          const hits = diff.filter((c) => c.object === dot[1] && c.field === dot[2]);
          for (const h of hits) {
            used.add(h);
            out.push({ ...h, source, detail: `${h.detail} (caused by ${obj.type} ${obj.name})` });
          }
          if (!hits.length && ctx.entitySets.includes(dot[1])) {
            const keys = (obj.keys ?? []).filter((k) => k.action === 'D').map((k) => k.key.slice(3));
            emit({ kind: keys.length ? 'values-removed' : 'logic-changed', object: dot[1], objectNames: setNames(ctx, dot[1]), field: dot[2], fieldNames: [dot[2]], ...(keys.length ? { values: keys } : {}), severity: keys.length ? 'breaking' : 'review', detail: `${obj.type} ${obj.name} changes ${t}${keys.length ? ` (deletes ${keys.join(', ')})` : ''}` });
          }
          continue;
        }
        if (ctx.entitySets.includes(t)) {
          const hits = diff.filter((c) => c.object === t);
          for (const h of hits) {
            used.add(h);
            out.push({ ...h, source, detail: `${h.detail} (caused by ${obj.type} ${obj.name})` });
          }
          if (!hits.length) emit({ kind: 'object-changed', object: t, objectNames: setNames(ctx, t), severity: 'review', detail: `${obj.type} ${obj.name} changes ${t}` });
          continue;
        }
        const app = ctx.apps.find((a) => normalizeLabel(a.title) === normalizeLabel(t) || a.intent === t || a.ui5App === t);
        if (app) {
          emit({ kind: obj.type === 'ACGR' ? 'security-changed' : 'ui-changed', object: `app:${app.title}`, objectNames: [...appNames(app), app.entitySet], severity: 'review', detail: `${obj.type} ${obj.name} changes the Fiori app "${app.title}"` });
          continue;
        }
        if (TCODE.test(t)) {
          const apps = ctx.apps.filter((a) => (a.tcodes ?? []).includes(t));
          emit({ kind: 'object-changed', object: `tcode:${t}`, objectNames: [t, `tcode:${t}`, ...apps.flatMap(appNames)], severity: 'review', detail: `${obj.type} ${obj.name} changes transaction ${t}${apps.length ? ` (also behind ${apps.map((a) => `"${a.title}"`).join(', ')})` : ''}` });
        }
      }
      if (out.length === before) emit({ kind: 'object-changed', object: `${obj.type} ${obj.name}`, objectNames: [obj.name], severity: 'review', detail: `${obj.pgmid} ${obj.type} ${obj.name} is not mapped to any transaction, app or field (add it to sap.objectMap)` });
    }
  }
  return { changes: out, unattributed: diff.filter((c) => !used.has(c)) };
}

function targetsOf(obj: TransportObject, map: Record<string, string[]>, ctx: SapTransportContext): string[] {
  const name = obj.name.split(/\s+/)[0];
  const out = [...(map[`${obj.type} ${name}`] ?? [])];
  if (obj.type === 'TRAN') out.push(name);
  if (obj.type === 'WAPA') out.push(...ctx.apps.filter((a) => a.ui5App === name).map((a) => a.title));
  if (['IWSV', 'SRVB', 'SRVD', 'IWOM', 'IWMO', 'DDLS'].includes(obj.type)) {
    const svc = ctx.services.find((s) => s.toUpperCase() === name.toUpperCase());
    if (svc) out.push(...ctx.apps.filter((a) => a.service === svc).map((a) => a.entitySet), ...ctx.entitySetsOf(svc));
  }
  return [...new Set(out)];
}

/** What a step touches, for SAP Fiori and SAP GUI journeys. */
export function sapScoper(apps: FioriApp[]): StepScoper {
  return (step: Step, cur) => {
    const h = step.handler ?? '';
    const a = step.args ?? {};
    const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
    const texts = [step.intent, step.value ?? ''].filter(Boolean);
    if (h === 'fiori.openApp') {
      const app = apps.find((x) => normalizeLabel(x.title) === normalizeLabel(s('app') ?? '') || x.intent === s('app'));
      const objs = app ? [app.entitySet, ...appNames(app), app.service, ...(app.tcodes ?? [])] : [s('app')!, `app:${s('app')}`];
      return { carry: objs, scope: { objects: objs, fields: [], texts } };
    }
    if (h === 'fiori.press') {
      const creates = /^(create|new|\+)$/i.test(s('button') ?? '') ? cur.objects[0] : undefined;
      return { scope: { objects: cur.objects, fields: [{ ref: s('button')! }], ...(creates ? { creates } : {}), texts } };
    }
    if (h === 'fiori.setField' || h === 'fiori.expectField' || h === 'fiori.expectFieldState' || h === 'fiori.expectValueHelp') {
      return { scope: { objects: cur.objects, fields: [{ ref: s('field')!, ...(s('value') !== undefined ? { value: s('value') } : {}) }], texts } };
    }
    if (h === 'fiori.verifyOData') {
      return { scope: { objects: [s('entity')!], fields: Object.entries((a.expect as Record<string, unknown>) ?? {}).map(([ref, v]) => ({ ref, value: String(v) })), texts } };
    }
    if (h.startsWith('fiori.')) return { scope: { objects: cur.objects, fields: [], texts } };
    // SAP GUI rung (desktop bridge): transactions and technical field names.
    if (h === 'sap.transaction') {
      const code = (s('code') ?? '').toUpperCase().replace(/^\/[NO]/, '');
      const apps2 = apps.filter((x) => (x.tcodes ?? []).includes(code));
      const objs = [code, `tcode:${code}`, ...apps2.map((x) => x.entitySet)];
      return { carry: objs, scope: { objects: objs, fields: [], creates: /01N?$/.test(code) ? code : undefined, texts } };
    }
    if (h.startsWith('sap.')) {
      const ref = s('field') ?? s('column') ?? s('button');
      return { scope: { objects: cur.objects, fields: ref ? [{ ref, ...(s('value') !== undefined ? { value: s('value') } : {}) }] : [], texts } };
    }
    return {};
  };
}
