/**
 * Accessibility findings of EZTest's accessibility engine: violations
 * grouped by rule and impact with their WCAG success criteria, an overlay on
 * the step screenshot outlining the offending elements (boxes captured by
 * the a11y lens), the count of items that need review, impact filters and
 * export.
 */
import { api } from '../core/api.js';
import { add, clear, h, uid } from '../core/dom.js';
import { link, navigate } from '../core/router.js';
import { button, emptyState } from '../ui/badge.js';
import { icon } from '../ui/icons.js';
import { download, pageHeader, runPicker, sevBadge, toCsv, withStates, type SubPageDef } from './assurance-ui.js';

type Impact = 'critical' | 'serious' | 'moderate' | 'minor';
const IMPACTS: Impact[] = ['critical', 'serious', 'moderate', 'minor'];

interface A11yNode {
  target: string[];
  html: string;
  failureSummary?: string;
  box?: { x: number; y: number; width: number; height: number };
}

interface A11yViolation {
  ruleId: string;
  impact: Impact | null;
  description: string;
  help: string;
  helpUrl: string;
  tags: string[];
  /** WCAG success criteria ("1.4.3"). */
  sc?: string[];
  nodes: A11yNode[];
}

interface A11yStep {
  journeyId: string;
  journeyName: string;
  stepId: string;
  intent: string;
  status: string;
  screenshot?: string;
  message?: string;
  scan?: { url: string; engine?: string; violations: A11yViolation[]; needsReview?: A11yViolation[]; counts: Record<Impact, number>; page?: { width: number; height: number; dpr: number } };
}

interface FlatNode extends A11yNode {
  step: A11yStep;
  rule: A11yViolation;
  key: string;
}

/** WCAG references from rule tags: "wcag143" -> "SC 1.4.3", "wcag21aa" -> "WCAG 2.1 AA". */
export function wcagRefs(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    let m = /^wcag(\d)(\d)(\d{1,2})$/.exec(t);
    if (m) {
      out.push(`SC ${m[1]}.${m[2]}.${m[3]}`);
      continue;
    }
    m = /^wcag(\d)(\d)?(a{1,3})$/.exec(t);
    if (m) out.push(`WCAG ${m[1]}.${m[2] ?? '0'} ${m[3].toUpperCase()}`);
    else if (t === 'best-practice') out.push('Best practice');
  }
  return out;
}

export async function mountA11yRun(el: HTMLElement, runId: string): Promise<void> {
  const r = await withStates(el, () => api.get<{ steps: A11yStep[] }>(`/api/assurance/a11y/runs/${encodeURIComponent(runId)}`), { retry: () => void mountA11yRun(el, runId) });
  if (!r) return;
  const steps = r.steps.filter((s) => s.scan);
  if (!steps.length) {
    el.appendChild(emptyState('No accessibility scans', 'Run with the a11y lens ("lenses: [a11y]" or "a11y:warn") to scan every step with EZTest\'s accessibility engine.'));
    return;
  }
  const on = new Set<Impact>(IMPACTS);
  let stepIdx = Math.max(0, steps.findIndex((s) => (s.scan?.violations.length ?? 0) > 0));
  let activeKey: string | undefined;
  const nodes: FlatNode[] = steps.flatMap((s) => (s.scan?.violations ?? []).flatMap((v) => v.nodes.map((n, i) => ({ ...n, step: s, rule: v, key: `${s.journeyId}/${s.stepId}/${v.ruleId}/${i}` }))));
  const rulesHost = h('div');
  const shotHost = h('div', { class: 'stack-sm' });
  const stepSel = h('select', { class: 'input input-sm', id: uid('a11y-step'), onchange: () => ((stepIdx = Number(stepSel.value)), renderShot()) }, steps.map((s, i) => h('option', { value: String(i), text: `${s.journeyName} › ${s.intent} (${s.scan!.violations.reduce((n, v) => n + v.nodes.length, 0)})` })));
  stepSel.value = String(stepIdx);

  const visible = () => nodes.filter((n) => on.has((n.rule.impact ?? 'minor') as Impact));

  const renderRules = () => {
    const byRule = new Map<string, FlatNode[]>();
    for (const n of visible()) byRule.set(n.rule.ruleId, [...(byRule.get(n.rule.ruleId) ?? []), n]);
    const rules = [...byRule.entries()].sort((a, b) => IMPACTS.indexOf((a[1][0].rule.impact ?? 'minor') as Impact) - IMPACTS.indexOf((b[1][0].rule.impact ?? 'minor') as Impact) || b[1].length - a[1].length);
    clear(rulesHost);
    if (!rules.length) {
      rulesHost.appendChild(emptyState('No violations', 'No violation at the selected impact levels.'));
      return;
    }
    rulesHost.appendChild(h('ul', { class: 'rule-list', 'aria-label': 'Violations by rule' }, rules.map(([ruleId, list]) => {
      const v = list[0].rule;
      return h('li', null, h('details', { class: 'rule', dataset: { rule: ruleId }, open: list.some((n) => n.key === activeKey) },
        h('summary', null, sevBadge(v.impact ?? 'minor', v.impact ?? 'n/a'), h('strong', { text: v.help }), h('code', { class: 'small', text: ruleId }), h('span', { class: 'count-pill', title: 'Elements', text: String(list.length) }), wcagRefs(v.tags).map((w) => h('span', { class: 'wcag', text: w }))),
        h('div', { class: 'rule-body stack-sm' },
          h('p', { text: v.description }),
          h('p', null, h('a', { href: v.helpUrl, target: '_blank', rel: 'noopener noreferrer' }, v.sc?.length ? `Understanding WCAG ${v.sc[0]} ` : 'How to fix ', icon('external', { size: 12 }))),
          h('ul', { class: 'node-list' }, list.map((n) => h('li', { class: 'node-item stack-sm', dataset: { key: n.key } },
            h('div', { class: 'row-between' }, h('code', { text: n.target.join(' ') }), n.box ? button('Show on screenshot', { small: true, icon: 'target', onclick: () => showNode(n), ariaLabel: `Show on screenshot: ${ruleId} ${n.target.join(' ')}` }) : h('span', { class: 'small muted', text: 'no position' })),
            h('p', { class: 'small muted', text: `${n.step.journeyName} › ${n.step.intent}` }),
            h('pre', { class: 'code-block', text: n.html }),
            n.failureSummary ? h('p', { class: 'small', text: n.failureSummary }) : null))))));
    })));
  };

  const showNode = (n: FlatNode) => {
    stepIdx = steps.indexOf(n.step);
    stepSel.value = String(stepIdx);
    activeKey = n.key;
    renderShot();
    const box = shotHost.querySelector<HTMLElement>(`[data-key="${CSS.escape(n.key)}"]`);
    box?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    box?.focus({ preventScroll: true });
  };

  const renderShot = () => {
    const s = steps[stepIdx];
    clear(shotHost);
    shotHost.appendChild(h('div', { class: 'row wrap' }, h('label', { for: stepSel.id, text: 'Step' }), stepSel));
    if (!s.screenshot) {
      shotHost.appendChild(emptyState('No screenshot', 'This step has no screenshot (screenshots are taken for every step in Studio runs).'));
      return;
    }
    const img = h('img', { src: s.screenshot, alt: `Screenshot after step: ${s.intent}` });
    const canvas = h('div', { class: 'shot-canvas' }, img);
    const pw = s.scan?.page?.width;
    const ph = s.scan?.page?.height;
    const place = () => {
      for (const b of canvas.querySelectorAll('.a11y-box')) b.remove();
      const W = pw ?? img.naturalWidth;
      const H = ph ?? img.naturalHeight;
      if (!W || !H) return;
      for (const n of visible().filter((x) => x.step === s && x.box)) {
        const b = n.box!;
        const btn = h('button', {
          type: 'button',
          class: ['a11y-box', `imp-${n.rule.impact ?? 'minor'}`, activeKey && activeKey !== n.key && 'dim', activeKey === n.key && 'active'],
          'aria-label': `${n.rule.impact ?? ''} ${n.rule.help}: ${n.target.join(' ')}`,
          title: `${n.rule.ruleId}: ${n.rule.help}`,
          dataset: { key: n.key, rule: n.rule.ruleId },
          onclick: () => {
            activeKey = n.key;
            renderRules();
            const item = rulesHost.querySelector<HTMLElement>(`[data-key="${CSS.escape(n.key)}"]`);
            item?.scrollIntoView({ block: 'nearest' });
            place();
          },
        });
        Object.assign(btn.style, { left: `${(b.x / W) * 100}%`, top: `${(b.y / H) * 100}%`, width: `${Math.max(0.3, (b.width / W) * 100)}%`, height: `${Math.max(0.3, (b.height / H) * 100)}%` });
        canvas.appendChild(btn);
      }
    };
    if (img.complete) place();
    else img.addEventListener('load', place, { once: true });
    const legend = h('ul', { class: 'legend' }, IMPACTS.map((i) => h('li', null, h('span', { class: `swatch a11y-swatch imp-${i}` }), i)));
    add(shotHost, h('div', { class: 'shot-wrap' }, canvas), legend, s.scan ? h('p', { class: 'small muted', text: `${s.scan.url}${s.scan.engine ? ` · ${s.scan.engine}` : ''}` }) : null);
  };

  const filters = h('fieldset', { class: 'fs row wrap' }, h('legend', { text: 'Impact' }), IMPACTS.map((i) => {
    const id = uid(`imp-${i}`);
    const count = nodes.filter((n) => n.rule.impact === i).length;
    const input = h('input', { type: 'checkbox', id, checked: true, onchange: () => (input.checked ? on.add(i) : on.delete(i), renderRules(), renderShot()) });
    return h('label', { class: 'check', for: id }, input, sevBadge(i), h('span', { class: 'muted', text: `(${count})` }));
  }));
  const exportRows = () => visible().map((n) => ({ journey: n.step.journeyName, step: n.step.intent, rule: n.rule.ruleId, impact: n.rule.impact, help: n.rule.help, wcag: wcagRefs(n.rule.tags).join('; '), target: n.target.join(' '), html: n.html, helpUrl: n.rule.helpUrl }));
  const actions = h('div', { class: 'row' },
    button('Export CSV', { small: true, icon: 'download', onclick: () => download(`a11y-${runId}.csv`, toCsv(['journey', 'step', 'rule', 'impact', 'help', 'wcag', 'target', 'html', 'helpUrl'], exportRows()), 'text/csv') }),
    button('Export JSON', { small: true, icon: 'download', onclick: () => download(`a11y-${runId}.json`, JSON.stringify(exportRows(), null, 2), 'application/json') }));
  const totals = IMPACTS.map((i) => `${nodes.filter((n) => n.rule.impact === i).length} ${i}`).join(' · ');
  const review = steps.reduce((n, s) => n + (s.scan?.needsReview ?? []).reduce((m, v) => m + v.nodes.length, 0), 0);
  el.append(
    h('div', { class: 'row-between' }, filters, actions),
    h('p', { class: 'muted', text: `${nodes.length} offending element(s) across ${steps.length} scanned step(s): ${totals}${review ? `; ${review} element(s) need manual review` : ''}` }),
    h('div', { class: 'two-col' }, rulesHost, shotHost),
  );
  renderRules();
  renderShot();
}

export const a11ySection: SubPageDef = {
  id: 'a11y',
  title: 'Accessibility',
  icon: 'contrast',
  description: 'Accessibility findings by rule, impact and WCAG criterion, on the screenshot',
  mount(root) {
    const body = h('div', { class: 'stack' });
    const picker = runPicker({ label: 'Run', lens: 'a11y', onChange: (id) => navigate(link('assurance', 'a11y', id)) });
    root.appendChild(h('div', { class: 'page-inner' }, pageHeader('Accessibility', 'Violations found by EZTest\'s accessibility engine, grouped by rule and impact with their WCAG success criteria; the offending elements are outlined on the step screenshot.', picker.el), body));
    return {
      show: async (segs) => {
        const runId = await picker.set(segs[0]);
        if (!runId) {
          clear(body).appendChild(emptyState('No accessibility scans yet', 'Add "a11y" (or "a11y:warn") to the lenses and run a journey: every step is scanned with EZTest\'s accessibility engine.'));
          return;
        }
        clear(body);
        await mountA11yRun(body, runId);
      },
    };
  },
};
