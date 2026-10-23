/**
 * Healing for component steps. When the widget container no longer resolves
 * (the markup changed between versions), the ordinary ladder runs first
 * (cache, fingerprint); then this tier looks at every widget of the step's
 * kind on the page and ranks them by how well their accessible name or
 * heading matches the description, and, for grid steps that name a row by
 * its cell values, by whether that row is in the grid. The runner only
 * accepts the heal when the step's own verification passes (the row is found
 * by its values and the action's read-back holds), so a heal can never act on
 * a different row or widget silently.
 */
import type { Locator } from '../../browser/index.js';
import type { LocatorCandidate } from '../../core/index.js';
import type { HealCandidate, HealContext, Healer, HealPolicy } from '../../heal/types.js';
import { HEAL_TIERS } from '../../heal/types.js';
import { textSimilarity } from '../../heal/similarity.js';
import { widgetNames, type ComponentWidget } from '../../intent/rules-components.js';
import { describeCandidate, toLocator, type LocatorRoot } from '../locate.js';
import { ACCORDION_DIALECTS, COMBO_DIALECTS, DATE_DIALECTS, DROPZONE_DIALECTS, EDITOR_DIALECTS, GRID_DIALECTS, SLIDER_DIALECTS, TABS_DIALECTS, TREE_DIALECTS } from './dialects.js';
import { engine } from './engine.js';
import { Grid } from './grid.js';
import type { CellCondition } from './types.js';

const ROOTS: Partial<Record<ComponentWidget, string[]>> = {
  grid: GRID_DIALECTS.map((d) => d.dialect.root),
  combobox: COMBO_DIALECTS.map((d) => d.dialect.root),
  datepicker: DATE_DIALECTS.map((d) => d.dialect.root),
  tree: TREE_DIALECTS.map((d) => d.dialect.root),
  tabs: TABS_DIALECTS.map((d) => d.dialect.root),
  accordion: ACCORDION_DIALECTS.filter((d) => d.library !== 'aria').map((d) => d.dialect.root),
  richtext: EDITOR_DIALECTS.map((d) => d.dialect.root),
  slider: SLIDER_DIALECTS.map((d) => d.dialect.root),
  dropzone: DROPZONE_DIALECTS.filter((d) => d.library !== 'aria').map((d) => d.dialect.root),
  chart: ['canvas', 'svg.highcharts-root', '[_echarts_instance_]'],
};

interface WidgetCandidate {
  tag: string;
  name: string;
  id: string;
  testid: string;
  ariaLabel: string;
  role: string;
  path: string;
}

function rank(name: string | undefined, c: WidgetCandidate): number {
  return Math.max(textSimilarity(name, c.name), textSimilarity(name, c.ariaLabel));
}

/** A locator that resolves to exactly this widget (checked through its mark). */
async function locatorFor(root: LocatorRoot, c: WidgetCandidate): Promise<LocatorCandidate | undefined> {
  const options: LocatorCandidate[] = [];
  if (c.testid) options.push({ strategy: 'testId', value: c.testid });
  if (c.id && /^[A-Za-z][\w-]*$/.test(c.id)) options.push({ strategy: 'css', value: `#${c.id}` });
  if (c.ariaLabel) options.push({ strategy: 'css', value: `[aria-label="${c.ariaLabel.replace(/"/g, '\\"')}"]` });
  if (c.role && c.ariaLabel) options.push({ strategy: 'role', value: c.role, name: c.ariaLabel, exact: true });
  if (c.path) options.push({ strategy: 'css', value: c.path });
  for (const o of options) {
    const loc = toLocator(root, o);
    if ((await loc.count().catch(() => 0)) !== 1) continue;
    const same = await loc.getAttribute('data-ezc', { timeout: 1000 }).catch(() => null);
    if (same === c.tag) return o;
  }
  return undefined;
}

/** Component-tier heal candidates for a component step whose widget no longer resolves. */
export async function* componentCandidates(ctx: HealContext): AsyncIterable<HealCandidate> {
  const note = ctx.note ?? (() => {});
  const a = ctx.step.args ?? {};
  const kind = String(a.widget ?? '') as ComponentWidget;
  const roots = ROOTS[kind];
  if (!roots) {
    note(`T2-component: no widget catalogue for "${kind}"`);
    return;
  }
  const body: Locator = ctx.root.locator('body');
  let list: WidgetCandidate[];
  try {
    list = await engine<WidgetCandidate[]>(body, 'widgetCandidates', { roots });
  } catch (e) {
    note(`T2-component: could not scan the page (${(e as Error).message.split('\n')[0]})`);
    return;
  }
  if (!list.length) {
    note(`T2-component: no ${kind} on the page`);
    return;
  }
  const names = widgetNames(ctx.target.description, kind);
  const where = Array.isArray(a.where) ? (a.where as CellCondition[]) : [];
  const scored: Array<{ c: WidgetCandidate; score: number; why: string[] }> = [];
  for (const c of list) {
    const sim = Math.max(...names.map((n) => rank(n, c)), 0);
    const why = [`name "${c.name || c.ariaLabel || '(none)'}" ~ "${names[0] ?? ''}" ${sim.toFixed(2)}`];
    let score = list.length === 1 ? Math.max(sim, 0.55) : sim;
    if (list.length === 1) why.push(`the only ${kind} on the page`);
    if (kind === 'grid' && where.length) {
      // A grid holding the row named by its values is very likely the grid the step meant.
      try {
        const g = await Grid.open(ctx.root.locator(`[data-ezc="${c.tag}"]`), { timeoutMs: 3000, budgetMs: 20_000 });
        const found = await g.scan(where, { first: true });
        if (found.matches.length) {
          score = Math.min(0.95, Math.max(score, 0.5) + 0.3);
          why.push(`holds the row where ${where.map((w) => `${w.column} ${w.op ?? 'equals'} "${w.value}"`).join(' and ')}`);
        } else {
          score *= 0.5;
          why.push('does not hold the row');
        }
      } catch (e) {
        why.push(`not readable (${(e as Error).message.split('\n')[0]})`);
        score *= 0.5;
      }
      // Marks were cleared by the grid scan: mark the candidates again for locator checks.
      list = await engine<WidgetCandidate[]>(body, 'widgetCandidates', { roots });
      const again = list.find((x) => x.path === c.path);
      if (again) c.tag = again.tag;
    }
    scored.push({ c, score, why });
  }
  scored.sort((x, y) => y.score - x.score);
  const best = scored[0];
  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < 0.08) {
    note(`T2-component: ${kind} candidates too close (${best.score.toFixed(2)} vs ${runnerUp.score.toFixed(2)})`);
    return;
  }
  const loc = await locatorFor(ctx.root, best.c);
  if (!loc) {
    note('T2-component: matched a widget but could not build a unique locator for it');
    return;
  }
  yield { locator: loc, tier: 'T2-semantic', confidence: Math.round(best.score * 1000) / 1000, reason: `component ${kind}: ${best.why.join('; ')} (${describeCandidate(loc)})` };
}

const tierRank = (t: string) => HEAL_TIERS.indexOf(t as (typeof HEAL_TIERS)[number]);

/** The healer's own ladder, then (for component steps, when the policy allows T2) the component tier. */
export async function* withComponentCandidates(healer: Healer, ctx: HealContext): AsyncIterable<HealCandidate> {
  yield* healer.candidates(ctx);
  if (ctx.step.action !== 'component') return;
  const policy = (healer as { policy?: HealPolicy }).policy;
  if (policy && (!policy.enabled || tierRank(policy.maxTier) < tierRank('T2-semantic'))) return;
  for await (const c of componentCandidates(ctx)) {
    if (policy && c.confidence < policy.minConfidence) {
      ctx.note?.(`T2-component: ${describeCandidate(c.locator)} confidence ${c.confidence.toFixed(2)} below ${policy.minConfidence}`);
      continue;
    }
    yield c;
  }
}
