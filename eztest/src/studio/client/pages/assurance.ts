/**
 * Assurance: document checks, ad-hoc document comparison, visual diff,
 * accessibility and security, as one page with its own section navigation
 * (`#/assurance/<section>/<runId>/...`) and as tabs in the run detail.
 */
import { h } from '../core/dom.js';
import { registerRunDetailTab, type RunDetail } from '../core/registry.js';
import { link } from '../core/router.js';
import { emptyState } from '../ui/badge.js';
import { a11ySection, mountA11yRun } from './assurance-a11y.js';
import { compareSection, documentsSection, mountRunDocument, runDocumentList } from './assurance-documents.js';
import { mountSecurityRun, securitySection } from './assurance-security.js';
import { registerSectionPage, sevBadge, withStates } from './assurance-ui.js';
import { mountVisualRun, visualSection } from './assurance-visual.js';

function hasLens(d: RunDetail, lens: string): boolean {
  return Object.values(d.evidence).some((e) => e.kind === 'data' && new RegExp(`(^|/)lens-${lens}-`).test(e.path));
}

function lensSteps(d: RunDetail, lens: string): number {
  return Object.values(d.evidence).filter((e) => e.kind === 'data' && new RegExp(`(^|/)lens-${lens}-`).test(e.path)).length;
}

function registerRunTabs(): void {
  registerRunDetailTab({
    id: 'documents',
    title: 'Documents',
    order: 55,
    when: (d) => Object.values(d.evidence).some((e) => e.kind === 'data' && e.path.startsWith('compare/')),
    badge: (d) => Object.values(d.evidence).filter((e) => e.kind === 'data' && e.path.startsWith('compare/')).length,
    mount(el, d, ctx) {
      let dispose: () => void = () => undefined;
      let alive = true;
      const list = h('div');
      const detail = h('div', { class: 'doc-detail' });
      el.append(list, detail);
      void (async () => {
        const items = await withStates(list, () => runDocumentList(d.run.runId));
        if (!items || !alive) return;
        if (!items.length) {
          list.appendChild(emptyState('No document checks', 'This run has no "Compare document" steps.'));
          return;
        }
        const pick = items.find((i) => i.journeyId === ctx.journeyId && (!ctx.stepId || i.stepId === ctx.stepId)) ?? items.find((i) => !i.passed) ?? items[0];
        const open = async (i: typeof pick) => {
          dispose();
          for (const b of list.querySelectorAll('[aria-pressed]')) b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.key === `${i.journeyId}/${i.stepId}`));
          dispose = await mountRunDocument(detail, d.run.runId, i.journeyId, i.stepId);
        };
        if (items.length > 1) {
          list.appendChild(h('div', { class: 'row wrap', role: 'group', 'aria-label': 'Document checks' }, items.map((i) => h('button', { type: 'button', class: 'btn btn-sm', 'aria-pressed': 'false', dataset: { key: `${i.journeyId}/${i.stepId}` }, onclick: () => void open(i) }, sevBadge(i.passed ? 'pass' : 'fail', i.passed ? 'PASS' : 'FAIL'), h('span', { text: `${i.journeyName} › ${i.intent}` })))));
        }
        list.appendChild(h('p', { class: 'small' }, h('a', { href: link('assurance', 'documents', d.run.runId, pick.journeyId, pick.stepId), text: 'Open in Assurance' })));
        await open(pick);
      })();
      return () => {
        alive = false;
        dispose();
      };
    },
  });
  registerRunDetailTab({
    id: 'visual',
    title: 'Visual',
    order: 56,
    when: (d) => hasLens(d, 'visual'),
    badge: (d) => lensSteps(d, 'visual'),
    mount(el, d) {
      void mountVisualRun(el, d.run.runId);
    },
  });
  registerRunDetailTab({
    id: 'a11y',
    title: 'Accessibility',
    order: 57,
    when: (d) => hasLens(d, 'a11y'),
    badge: (d) => lensSteps(d, 'a11y'),
    mount(el, d) {
      void mountA11yRun(el, d.run.runId);
    },
  });
  registerRunDetailTab({
    id: 'security',
    title: 'Security',
    order: 58,
    when: (d) => hasLens(d, 'security'),
    mount(el, d) {
      void mountSecurityRun(el, d.run.runId);
    },
  });
}

export function registerAssurancePage(): void {
  registerSectionPage({
    id: 'assurance',
    title: 'Assurance',
    icon: 'shield',
    order: 55,
    sections: [documentsSection, compareSection, visualSection, a11ySection, securitySection],
  });
  registerRunTabs();
}
