/**
 * The "Features" tab of a run in Results: Gherkin scenarios grouped by
 * feature and rule, each scenario (and Examples row) with its steps, how
 * each step was bound (step definition, EZTest phrasing, undefined,
 * ambiguous), and links to the scenario's timeline and to the feature file.
 */
import { add, h } from '../core/dom.js';
import { ms } from '../core/format.js';
import { registerRunDetailTab, type RunDetail } from '../core/registry.js';
import { link } from '../core/router.js';
import { badge, statusIcon } from '../ui/badge.js';

type J = RunDetail['run']['journeys'][number];

interface Group {
  name: string;
  file: string;
  line: number;
  scenarios: J[];
  rules: Array<{ name: string; line: number; scenarios: J[] }>;
}

const RANK: Record<string, number> = { passed: 0, 'passed-healed': 1, skipped: 2, failed: 3, error: 4 };

/** The worst status of a group (all skipped: skipped). */
export function groupStatus(list: string[]): string {
  if (!list.length || list.every((s) => s === 'skipped')) return 'skipped';
  return list.reduce((w, s) => (s !== 'skipped' && (RANK[s] ?? 0) > (RANK[w] ?? 0) ? s : w), 'passed');
}

/** Gherkin results of a run by feature file (in file order), rules and scenarios in line order. */
export function featureGroups(d: RunDetail): Group[] {
  const by = new Map<string, Group>();
  for (const j of d.run.journeys) {
    const b = j.bdd;
    if (!b) continue;
    let g = by.get(b.file);
    if (!g) by.set(b.file, (g = { name: b.feature.name, file: b.file, line: b.feature.line, scenarios: [], rules: [] }));
    if (b.rule) {
      let r = g.rules.find((x) => x.line === b.rule!.line);
      if (!r) g.rules.push((r = { name: b.rule.name, line: b.rule.line, scenarios: [] }));
      r.scenarios.push(j);
    } else g.scenarios.push(j);
  }
  const line = (j: J) => j.bdd?.examples?.row?.line ?? j.bdd?.scenario.line ?? 0;
  const out = [...by.values()].sort((a, b) => a.file.localeCompare(b.file));
  for (const g of out) {
    g.scenarios.sort((a, b) => line(a) - line(b));
    g.rules.sort((a, b) => a.line - b.line);
    for (const r of g.rules) r.scenarios.sort((a, b) => line(a) - line(b));
  }
  return out;
}

const MATCH: Record<string, string> = { definition: 'step definition', ez: 'EZTest phrasing', undefined: 'undefined', ambiguous: 'ambiguous', hook: 'hook' };

function scenarioItem(d: RunDetail, j: J): HTMLElement {
  const b = j.bdd!;
  const steps = j.steps.filter((s) => s.gherkin);
  const det = h('details', { class: ['bdd-scenario', `st-${j.status}`], open: j.status === 'failed' || j.status === 'error', dataset: { journey: j.journeyId } });
  det.appendChild(h('summary', null,
    statusIcon(j.status),
    h('span', { class: 'bdd-kw', text: `${b.scenario.keyword}: ` }),
    h('a', { href: link('runs', d.run.runId, j.journeyId), text: j.name }),
    h('span', { class: 'muted', text: ` · line ${b.examples?.row?.line ?? b.scenario.line}${b.examples ? ` · ${b.examples.name || 'Examples'} row ${(b.examples.row?.index ?? 0) + 1}` : ''} · ${ms(j.durationMs)}${j.browser ? ` · ${j.browser}` : ''}` }),
  ));
  det.appendChild(h('ol', { class: 'bdd-steps' }, steps.map((s) => {
    const g = s.gherkin!;
    return h('li', { class: ['bdd-step', `st-${s.status}`, g.kind !== 'step' && 'bdd-hook'] },
      h('div', { class: 'tl-row' },
        statusIcon(s.status),
        g.kind === 'step' ? h('span', { class: 'bdd-kw', text: `${g.keyword ?? ''} ` }) : null,
        h('a', { class: 'tl-intent', href: link('runs', d.run.runId, j.journeyId, s.stepId), text: g.kind === 'step' ? g.text ?? s.intent : s.intent }),
        g.match ? h('span', { class: ['tag', `bdd-match-${g.match}`], title: g.location ?? '', text: MATCH[g.match] ?? g.match }) : null,
        h('span', { class: 'muted', text: ms(s.durationMs) }),
      ),
      s.error && s.status !== 'skipped' ? h('p', { class: 'error-note', text: s.error.message }) : null,
      g.snippet ? h('pre', { class: 'code-preview bdd-snippet', tabindex: '0', 'aria-label': 'Step definition snippet', text: g.snippet }) : null,
    );
  })));
  return h('li', null, det);
}

export function registerFeaturesTab(): void {
  registerRunDetailTab({
    id: 'features',
    title: 'Features',
    order: 15,
    when: (d) => d.run.journeys.some((j) => j.bdd),
    badge: (d) => featureGroups(d).length || undefined,
    mount(el, d) {
      for (const g of featureGroups(d)) {
        const all = [...g.scenarios, ...g.rules.flatMap((r) => r.scenarios)];
        const st = groupStatus(all.map((j) => j.status));
        const passed = all.filter((j) => j.status === 'passed' || j.status === 'passed-healed').length;
        const det = h('details', { class: ['bdd-feature', `st-${st}`], open: true });
        det.appendChild(h('summary', null,
          statusIcon(st),
          h('strong', { text: g.name || g.file }),
          h('span', { class: 'muted', text: ` · ` }),
          h('a', { href: link('journeys', `${g.file}:${g.line}`), text: g.file }),
          h('span', { class: 'muted', text: ` · ${passed}/${all.length} scenarios passed` }),
          badge(st),
        ));
        const list = h('ul', { class: 'bdd-list' }, g.scenarios.map((j) => scenarioItem(d, j)));
        for (const r of g.rules) {
          const rst = groupStatus(r.scenarios.map((j) => j.status));
          list.appendChild(h('li', null, h('details', { class: ['bdd-rule', `st-${rst}`], open: true },
            h('summary', null, statusIcon(rst), h('span', { class: 'bdd-kw', text: 'Rule: ' }), h('span', { text: r.name }), h('span', { class: 'muted', text: ` · line ${r.line}` })),
            h('ul', { class: 'bdd-list' }, r.scenarios.map((j) => scenarioItem(d, j))),
          )));
        }
        det.appendChild(list);
        add(el, det);
      }
    },
  });
}
