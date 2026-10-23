/**
 * Oracle Fusion quarterly update impact (e.g. 25C -> 25D): describe
 * snapshots of the configured REST resources (attribute titles, types,
 * mandatory/updatable, LOV values) on the current pod and on a test pod that
 * already has the update, diffed through the shared snapshot differ, plus the
 * update's feature list (CSV/JSON: Update, Feature, Change_Type, Page, Field,
 * New_Value, Description). Redwood pages use the same attribute titles as
 * their field labels, so a relabeled attribute points at the UI steps too.
 */
import type { Step } from '../../core/index.js';
import { makeSnapshot, type AppObjectMeta, type AppSnapshot, type StepScoper } from '../common/impact.js';
import { normalizeLabel } from '../common/kit.js';
import { releaseNoteChanges } from '../common/release-notes.js';
import type { OracleRestClient } from './client.js';

export async function snapshotOracle(client: OracleRestClient, o: { release?: string; source?: string } = {}): Promise<AppSnapshot> {
  const objs: AppObjectMeta[] = [];
  for (const r of client.resources) {
    const d = await client.describe(r.name);
    const fields = [];
    for (const a of d.attributes) {
      const values = a.lov ? await client.lovValues(r.name, a).catch(() => []) : [];
      fields.push({ name: a.name, label: a.title, type: a.type, required: a.mandatory, readOnly: !a.updatable && !a.mandatory, ...(values.length ? { values } : {}), aliases: [a.name] });
    }
    objs.push({ name: r.name, label: d.title, aliases: [...(r.label ? [r.label] : []), ...(r.pages ?? []).flatMap((p) => [p, `page:${p}`])], fields });
  }
  return makeSnapshot('oracle', objs, { source: o.source ?? client.o.url, release: o.release });
}

export const featureListChanges = (rows: Array<Record<string, string>>, update: string) =>
  releaseNoteChanges('oracle', rows, update, { objectColumn: 'Page', objectPrefix: 'page:', sourceLabel: `Oracle ${update} feature list` });

/** What an Oracle step touches; `pages` maps page names to the REST resources behind them. */
export function oracleScoper(resources: Array<{ name: string; label?: string; pages?: string[] }>): StepScoper {
  return (step: Step, cur) => {
    const h = step.handler ?? '';
    const a = step.args ?? {};
    const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
    const texts = [step.intent].filter(Boolean);
    if (h === 'oracle.navigate') {
      const p = (s('page') ?? '').split(/\s*>\s*/).pop()!;
      const res = resources.filter((r) => (r.pages ?? []).some((x) => normalizeLabel(x) === normalizeLabel(p))).map((r) => r.name);
      const objs = [`page:${p}`, p, ...res];
      return { carry: objs, scope: { objects: objs, fields: [], ...(/^create\b|request$/i.test(p) ? { creates: res[0] ?? `page:${p}` } : {}), texts } };
    }
    if (h === 'oracle.setField' || h === 'oracle.expectField' || h === 'oracle.expectFieldState') {
      return { scope: { objects: cur.objects, fields: [{ ref: s('field')!, ...(s('value') !== undefined ? { value: s('value') } : {}) }], texts } };
    }
    if (h === 'oracle.setCell') return { scope: { objects: cur.objects, fields: [{ ref: s('column')!, value: s('value') }], texts } };
    if (h === 'oracle.verifyRest') {
      const r = resources.find((x) => x.name === s('resource') || (x.label && normalizeLabel(x.label) === normalizeLabel(s('resource') ?? '')));
      return { scope: { objects: [r?.name ?? s('resource')!], fields: Object.entries((a.expect as Record<string, unknown>) ?? {}).map(([ref, v]) => ({ ref, value: String(v) })), texts } };
    }
    if (h === 'oracle.expectPage') return { scope: { objects: [`page:${s('page')}`, s('page')!], fields: [], texts } };
    if (h.startsWith('oracle.')) return { scope: { objects: cur.objects, fields: [], texts } };
    return {};
  };
}
