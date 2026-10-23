/**
 * Coverage analytics without a browser: interactive elements by role and
 * accessible name from trace snapshots, route templates, the UI coverage map
 * from synthetic traces (interactions, assertions, groups, hidden elements,
 * unvisited links, the heat overlay), failure tags over three histories,
 * accessibility trends with per-component scopes, the combined view and the
 * readiness gates.
 */
import { describe, expect, it } from '../support/testkit.js';
import {
  a11yTrend, combineCoverage, computeUiCoverage, interactiveElements, overlayCss, overlayMarks, routeTemplate, uiCoverageText,
  type A11yRunIssues, type TraceInput,
} from '../../src/analytics/index.js';
import { failureTags, evaluateReadiness, uniqueErrors, type RunHistoryEntry } from '../../src/insights/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import type { SnapshotRef, TraceFile, TraceStep } from '../../src/runner/trace/types.js';
import type { RunResult } from '../../src/core/index.js';

const ORDER_PAGE = (id: number, withCancel = true) => `<!DOCTYPE html><html data-ez-nid="1"><head data-ez-nid="2"><title data-ez-nid="3">Order</title><style data-ez-nid="4">button{color:red}</style></head><body data-ez-nid="5">
<nav data-ez-nid="6"><a data-ez-nid="7" href="/dashboard">Dashboard</a> <a data-ez-nid="8" href="/orders/new" class="btn">New order</a> <a data-ez-nid="9" href="/reports">Reports</a></nav>
<h1 data-ez-nid="10">Order <span data-ez-nid="11" data-testid="order-number">ORD-${id}</span></h1>
<p data-ez-nid="12"><a data-ez-nid="13" id="download-invoice" href="/orders/${id}/invoice.pdf" download="INV-${id}.pdf">Download invoice</a></p>
${withCancel ? `<form data-ez-nid="14" method="post" action="/orders/${id}/cancel"><button data-ez-nid="15" type="submit" id="cancel-order"><span data-ez-nid="16">Cancel</span> order</button></form>` : ''}
<label data-ez-nid="17" for="note">Note</label><input data-ez-nid="18" id="note" name="note" value="">
<input data-ez-nid="19" type="hidden" name="csrf" value="x"><button data-ez-nid="20" style="display: none">Secret admin</button><button data-ez-nid="21" data-ez-hidden="1">Collapsed</button>
<div data-ez-nid="22" role="tab" aria-label="History tab">History</div>
<select data-ez-nid="23" aria-labelledby="ship-l"><option data-ez-nid="24" value="a">A</option></select><span data-ez-nid="25" id="ship-l">Shipping &amp; handling</span>
<input data-ez-nid="26" type="checkbox" aria-label="Gift wrap"><input data-ez-nid="27" type="submit">
<iframe data-ez-nid="28" srcdoc="&lt;!DOCTYPE html&gt;&lt;html data-ez-nid=&quot;29&quot;&gt;&lt;body data-ez-nid=&quot;30&quot;&gt;&lt;button data-ez-nid=&quot;31&quot;&gt;Chat&lt;/button&gt;&lt;/body&gt;&lt;/html&gt;"></iframe>
</body></html>`;

const NEW_ORDER = `<!DOCTYPE html><html data-ez-nid="1"><body data-ez-nid="2"><form data-ez-nid="3"><label data-ez-nid="4" for="qty">Quantity</label><input data-ez-nid="5" id="qty" type="number"><button data-ez-nid="6" type="submit">Submit order</button></form><a data-ez-nid="7" href="/dashboard">Dashboard</a></body></html>`;

function snap(path: string, url: string, phase: 'before' | 'after', targetNid?: number): SnapshotRef {
  return { phase, path, sha256: path, bytes: 1, url, title: 't', viewport: { width: 1280, height: 800, deviceScaleFactor: 1 }, scroll: { x: 0, y: 0 }, nodeCount: 30, engine: 'in-page', capturedAt: '2026-10-23T00:00:00Z', ...(targetNid ? { target: { nid: targetNid, box: { x: 0, y: 0, width: 1, height: 1 }, tag: 'button' } } : {}) };
}

function step(index: number, stepId: string, action: string, before: SnapshotRef, after: SnapshotRef, used?: TraceStep['locator']['used']): TraceStep {
  return {
    index, execution: 1, stepId, intent: stepId, action, status: 'passed', startedAt: '', durationMs: 1, timings: {}, locator: { tried: [], ...(used ? { used } : {}) },
    conditions: [], snapshots: { before, after }, network: [], console: [], url: { before: before.url, after: after.url },
  };
}

function trace(runId: string, journeyId: string, steps: TraceStep[], files: Record<string, string>): TraceInput {
  const t: TraceFile = { format: 'eztest-trace', version: 1, source: 'eztest', runId, journeyId, journeyName: journeyId, attempt: 1, browser: 'chromium', startedAt: '', finishedAt: '', durationMs: 1, status: 'passed', steps, unattributed: { network: [], console: [] }, resources: {}, dir: `trace/${journeyId}-1` };
  return { runId, trace: t, read: async (ref) => files[ref.path] };
}

describe('snapshot elements', () => {
  it('finds visible interactive elements by role and accessible name (labels, aria-label/labelledby, content, defaults, iframes)', () => {
    const s = interactiveElements(ORDER_PAGE(12));
    expect(s.elements.map((e) => `${e.role}:${e.name}`)).toEqual([
      'link:Dashboard', 'link:New order', 'link:Reports', 'link:Download invoice', 'button:Cancel order', 'textbox:Note', 'tab:History tab',
      'combobox:Shipping & handling', 'checkbox:Gift wrap', 'button:Submit', 'button:Chat',
    ]);
    expect(s.elements.find((e) => e.name === 'Chat')!.frame).toBe(1);
    expect(s.elements.find((e) => e.name === 'Download invoice')).toMatchObject({ id: 'download-invoice', href: '/orders/12/invoice.pdf' });
    // a click on the span inside the button belongs to the button
    expect(s.owner(16)).toBe(15);
    expect(s.owner(10)).toBeUndefined();
  });

  it('templates routes: ids, UUIDs and hashes become :id; configured patterns win; hash routes count', () => {
    expect(routeTemplate('http://a.test/orders/12?created=1')).toBe('/orders/:id');
    expect(routeTemplate('http://a.test/orders/12/invoice.pdf')).toBe('/orders/:id/invoice.pdf');
    expect(routeTemplate('http://a.test/u/0f8fad5b-d9cb-469f-a165-70867728950e/edit')).toBe('/u/:id/edit');
    expect(routeTemplate('http://a.test/accounts/ACC-12345')).toBe('/accounts/:id');
    expect(routeTemplate('http://a.test/orders/new')).toBe('/orders/new');
    expect(routeTemplate('http://a.test/teams/blue/members', { routes: ['/teams/:team/members'] })).toBe('/teams/:team/members');
    expect(routeTemplate('http://a.test/app/#/orders/7')).toBe('/app#/orders/:id');
  });
});

describe('the UI coverage map', () => {
  const files = { 'a.gz': NEW_ORDER, 'b.gz': ORDER_PAGE(12), 'c.gz': ORDER_PAGE(13), 'd.gz': ORDER_PAGE(13, false) };
  const journeys = [parseEzScript('Journey: Create order\nGo to /orders/new\nFill the Quantity field with 3\nClick the "Submit order" button\n  Expect the "Download invoice" link is visible')];

  it('marks interacted and asserted elements, groups pages by route, lists untested elements and unvisited links', async () => {
    const create = trace('run-1', 'create-order', [
      step(0, 'fill-the-quantity-field-with-3', 'fill', snap('a.gz', 'http://shop.test/orders/new', 'before', 5), snap('a.gz', 'http://shop.test/orders/new', 'after')),
      step(1, 'click-the-submit-order-button', 'click', snap('a.gz', 'http://shop.test/orders/new', 'before', 6), snap('b.gz', 'http://shop.test/orders/12?created=1', 'after')),
    ], files);
    const r = await computeUiCoverage([create], journeys);
    expect(r.pages.map((p) => [p.route, p.tested, p.total])).toEqual([['/orders/:id', 1, 11], ['/orders/new', 2, 3]]);
    const order = r.pages.find((p) => p.route === '/orders/:id')!;
    expect(order.elements.filter((e) => e.tested).map((e) => [e.label, e.interactions, e.assertions])).toEqual([['Download invoice', 0, 1]]);
    expect(order.elements.find((e) => e.label === 'Cancel order')).toMatchObject({ tested: false, role: 'button' });
    expect(r.pages.find((p) => p.route === '/orders/new')!.elements.filter((e) => e.tested).map((e) => e.label).sort()).toEqual(['Quantity', 'Submit order']);
    expect(r.unvisitedLinks.map((l) => l.route)).toEqual(['/dashboard', '/orders/:id/invoice.pdf', '/reports']);
    expect(r.totals).toMatchObject({ pages: 2, elements: 14, tested: 3 });
    expect(uiCoverageText(r)).toContain('UNTESTED  button     Cancel order');

    // a second journey that clicks Cancel order raises coverage; ORD-12 / ORD-13 pages are one route
    const cancel = trace('run-2', 'cancel-order', [step(0, 'click-the-cancel-order-button', 'click', snap('c.gz', 'http://shop.test/orders/13', 'before', 16), snap('d.gz', 'http://shop.test/orders/13?cancelled=1', 'after'))], files);
    const r2 = await computeUiCoverage([create, cancel], journeys);
    const order2 = r2.pages.find((p) => p.route === '/orders/:id')!;
    expect(order2.elements.find((e) => e.label === 'Cancel order')).toMatchObject({ tested: true, interactions: 1, journeys: ['cancel-order'] });
    expect(r2.totals.tested).toBe(r.totals.tested + 1);
    expect(r2.totals.percent).toBeGreaterThan(r.totals.percent);
    expect(order2.journeys).toEqual(['cancel-order', 'create-order']);

    // heat overlay: tested solid green, untested dashed red, on the representative snapshot's node ids
    const marks = overlayMarks(files['b.gz'], order2);
    expect(marks.find((m) => m.nid === 15)).toMatchObject({ tested: true, label: 'Cancel order' });
    expect(marks.find((m) => m.nid === 9)).toMatchObject({ tested: false, label: 'Reports' });
    const css = overlayCss(marks, marks.find((m) => m.nid === 9)!.key);
    expect(css).toContain('[data-ez-nid="15"]{outline:3px solid');
    expect(css).toContain('[data-ez-nid="9"]{outline:3px dashed #dc2626');
    expect(css).toContain('box-shadow:0 0 0 6px');
  });

  it('honours ignore rules, number grouping and reports missing traces', async () => {
    const t = trace('r', 'j', [step(0, 's', 'click', snap('b.gz', 'http://shop.test/orders/1', 'before'), snap('b.gz', 'http://shop.test/orders/1', 'after'))], files);
    const r = await computeUiCoverage([t], [], { ignore: ['link:Dashboard', 'checkbox'], ignoreRoutes: ['/orders/new'] });
    const labels = r.pages[0].elements.map((e) => e.label);
    expect(labels).not.toContain('Dashboard');
    expect(labels).not.toContain('Gift wrap');
    expect((await computeUiCoverage([], [])).warnings[0]).toMatch(/enable trace\.timeTravel/);
  });
});

describe('failure tags', () => {
  const run = (runId: string, day: number, outcomes: Array<[string, 'passed' | 'failed', string?]>): RunHistoryEntry => ({
    runId, startedAt: `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`, outcomes: outcomes.map(([journeyId, status, signature]) => ({ journeyId, status, durationMs: 1, attempt: 1, ...(signature ? { signature } : {}) })),
  });

  it('tags new failures, always-failing journeys, regressions and flaky ones from three histories', () => {
    const h1 = [run('a', 1, [['j', 'passed']]), run('b', 2, [['j', 'passed']]), run('c', 3, [['j', 'failed', 's1']])];
    expect(failureTags(h1, 'c')).toEqual([{ journeyId: 'j', tags: ['new-failure', 'regressed'], failingStreak: 1, window: 3, signature: 's1' }]);
    const h2 = [run('a', 1, [['j', 'failed', 's1']]), run('b', 2, [['j', 'failed', 's1']]), run('c', 3, [['j', 'failed', 's1']])];
    expect(failureTags(h2, 'c')[0]).toMatchObject({ tags: ['always-failing'], failingStreak: 3 });
    const h3 = [run('a', 1, [['j', 'failed', 's']]), run('b', 2, [['j', 'passed']]), run('c', 3, [['j', 'failed', 's']]), run('d', 4, [['j', 'passed']]), run('e', 5, [['j', 'failed', 's']])];
    expect(failureTags(h3, 'e')[0].tags).toEqual(['regressed', 'flaky']);
    // first run ever: not "new" (nothing to compare with); passing journeys get no tags
    expect(failureTags([run('a', 1, [['j', 'failed', 's'], ['k', 'passed']])], 'a')).toEqual([{ journeyId: 'j', tags: [], failingStreak: 1, window: 1, signature: 's' }]);
  });

  it('groups a run\'s failures into unique errors and gates readiness on new failures', () => {
    const jr = (id: string, msg?: string) => ({ journeyId: id, name: id, status: msg ? 'failed' as const : 'passed' as const, startedAt: '', durationMs: 1, tags: [], requirements: [], risk: 3, attempt: 1, ledger: {}, evidence: [], steps: [{ stepId: 's', intent: 's', status: msg ? 'failed' as const : 'passed' as const, startedAt: '', durationMs: 1, conditions: [], evidence: [], ...(msg ? { error: { message: msg } } : {}) }] });
    const r: RunResult = { runId: 'c', startedAt: '', finishedAt: '', durationMs: 1, environment: {}, summary: { total: 3, passed: 1, passedHealed: 0, failed: 2, skipped: 0, errors: 0 }, journeys: [jr('a', 'Timeout 5000ms waiting for #save'), jr('b', 'Timeout 7000ms waiting for #save'), jr('c')] };
    const u = uniqueErrors(r);
    expect(u).toHaveLength(1);
    expect(u[0].journeys).toEqual(['a', 'b']);
    const gate = evaluateReadiness('version: 1\ngates:\n  noNewFailures: true\n', { run: r, evidence: [], failureTags: [{ journeyId: 'a', tags: ['new-failure'] }] });
    expect(gate.gates[0]).toMatchObject({ gate: 'noNewFailures', status: 'fail' });
    expect(gate.gates[0].cites.journeys).toEqual(['a']);
  });
});

describe('accessibility trends', () => {
  const issues = (runId: string, list: Array<[string, string, string]>): A11yRunIssues => ({
    runId, scannedSteps: 3, issues: list.map(([ruleId, route, target]) => ({ key: `${ruleId}|${route}|${target}`, ruleId, impact: 'serious', help: ruleId, route, target, component: target.startsWith('#chat') ? 'Chat widget' : route, level: 'error', journeys: ['j'], evidence: ['E-1'] })),
  });
  it('reports new, fixed and persisting issues by rule and component', () => {
    const t = a11yTrend([
      issues('r1', [['contrast.text', '/orders/:id', '#cancel-order'], ['name.form-field', '/orders/new', '#qty']]),
      { runId: 'r-none', scannedSteps: 0, issues: [] },
      issues('r2', [['name.form-field', '/orders/new', '#qty'], ['name.button', '/orders/:id', '#chat > button']]),
    ]);
    expect(t.points.map((p) => [p.runId, p.total, p.new, p.fixed])).toEqual([['r1', 2, 0, 0], ['r2', 2, 1, 1]]);
    expect(t.latest!.new.map((i) => i.ruleId)).toEqual(['name.button']);
    expect(t.latest!.fixed.map((i) => i.ruleId)).toEqual(['contrast.text']);
    expect(t.latest!.persisting.map((i) => i.ruleId)).toEqual(['name.form-field']);
    expect(t.byComponent.find((c) => c.component === 'Chat widget')).toMatchObject({ open: 1, new: 1 });
  });
});

describe('combined coverage and the UI gate', () => {
  it('combines UI, requirements, API, risk, change and manual into one view', () => {
    const c = combineCoverage({
      journeys: [{ id: 'a', risk: 5, status: 'passed' }, { id: 'b', risk: 3, status: 'failed' }, { id: 'm', risk: 2, status: 'passed', type: 'manual', manualSteps: 4, manualPending: 1 }],
      impact: { changedFiles: ['src/orders.ts', 'README.md', 'src/x.ts'], ignoredFiles: ['README.md'], impacted: [{ journeyId: 'a', score: 1, risk: 5, via: [{ file: 'src/orders.ts', mapping: 'orders', match: 'tag', value: 'orders' }] }], uncovered: [{ file: 'src/x.ts', reason: 'no-mapping' }] },
    });
    const byId = Object.fromEntries(c.dimensions.map((d) => [d.id, d]));
    expect(byId.risk).toMatchObject({ covered: 7, total: 10, status: 'warn' });
    expect(byId.manual).toMatchObject({ covered: 3, total: 4 });
    expect(byId.change).toMatchObject({ covered: 1, total: 2 });
    expect(byId.change.gaps[0].text).toBe('src/x.ts: no impact mapping covers it');
    expect(byId.ui.status).toBe('no-data');
    expect(c.overall).toBeCloseTo((0.7 + 0.75 + 0.5) / 3);
  });

  it('readiness: uiCoverage passes, fails below the minimum or per page, and is no-data without snapshots', () => {
    const run: RunResult = { runId: 'r', startedAt: '', finishedAt: '', durationMs: 1, environment: {}, summary: { total: 1, passed: 1, passedHealed: 0, failed: 0, skipped: 0, errors: 0 }, journeys: [{ journeyId: 'j', name: 'j', status: 'passed', startedAt: '', durationMs: 1, tags: [], requirements: [], risk: 3, attempt: 1, ledger: {}, evidence: [], steps: [{ stepId: 's', intent: 's', status: 'passed', startedAt: '', durationMs: 1, conditions: [], evidence: [] }] }] };
    const evidence = [{ id: 'E-9', kind: 'report' as const, path: 'coverage/ui.json', sha256: 'x', createdAt: '' }];
    const ui = { percent: 0.6, tested: 6, total: 10, evidence: ['E-9'], pages: [{ route: '/a', percent: 0.9, tested: 9, total: 10, journeys: ['j'] }, { route: '/b', percent: 0.2, tested: 1, total: 5, journeys: ['j'] }] };
    const ok = evaluateReadiness('version: 1\ngates:\n  uiCoverage: 0.5\n', { run, evidence, uiCoverage: ui });
    expect(ok.gates[0]).toMatchObject({ gate: 'uiCoverage', status: 'pass', cites: { evidence: ['E-9'], journeys: ['j'] } });
    const low = evaluateReadiness('version: 1\ngates:\n  uiCoverage: { min: 0.5, minPerPage: 0.5 }\n', { run, evidence, uiCoverage: ui });
    expect(low.gates[0].status).toBe('fail');
    expect(low.gates[0].summary).toContain('below 50.0% on /b (20.0%)');
    const scoped = evaluateReadiness('version: 1\ngates:\n  uiCoverage: { min: 0.8, pages: ["/a", "/missing"] }\n', { run, evidence, uiCoverage: ui });
    expect(scoped.gates[0].summary).toContain('pages never visited: /missing');
    expect(evaluateReadiness('version: 1\ngates:\n  uiCoverage: 0.5\n', { run, evidence }).gates[0].status).toBe('no-data');
  });
});
