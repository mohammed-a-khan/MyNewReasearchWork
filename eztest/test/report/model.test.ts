/** The report data model, the charts, the CSV and JSON exports and the chat cards (no browser). */
import { describe, it, expect, beforeAll } from '../support/testkit.js';
import Ajv2020 from 'ajv/dist/2020.js';
import { summarize, type JourneyResult, type RunResult } from '../../src/core/index.js';
import {
  applyIntegrationLinks, assignLanes, buildReportModel, buildSlackMessage, buildTeamsCard, cardLinks, columnChart, compareRunResults, csvCell, dataRowOf, donutChart,
  durationBins, fmtMs, heatmap, hbarChart, kpisOf, lineChart, niceTicks, renderTestsCsv, testState, trendFromHistory, buildJsonReport, REPORT_JSON_SCHEMA, buildRunContext, adoWeb, safeHttpUrl,
  brandCss, maskHeaders, maskUrl,
} from '../../src/report/index.js';
import { projectName } from '../../src/engine/analyze.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRichFixture, type RichFixture } from './rich-fixture.js';

let rich: RichFixture;
beforeAll(async () => {
  rich = await makeRichFixture();
});

const j = (id: string, status: JourneyResult['status'], extra: Partial<JourneyResult> = {}): JourneyResult => ({
  journeyId: id, name: id, status, startedAt: '2026-10-01T10:00:00.000Z', durationMs: 1000, steps: [{ stepId: 's1', intent: 'x', status: status === 'skipped' ? 'skipped' : status === 'failed' ? 'failed' : 'passed', startedAt: '2026-10-01T10:00:00.000Z', durationMs: 900, conditions: [], evidence: [], ...(status === 'failed' ? { error: { message: 'boom 42' } } : {}) }],
  tags: [], requirements: [], risk: 3, attempt: 1, ledger: {}, evidence: [], ...extra,
});
const runOf = (js: JourneyResult[], id = 'r1', at = '2026-10-01T10:00:00.000Z'): RunResult => ({ runId: id, startedAt: at, finishedAt: at, durationMs: 5000, journeys: js, summary: summarize(js), environment: {} });

describe('test states and key figures', () => {
  it('counts each test once: passed, healed, flaky (passed on retry), failed, error, skipped; hooks are not tests', () => {
    const js = [j('a', 'passed'), j('b', 'passed-healed'), j('c', 'passed', { attempt: 2 }), j('d', 'failed'), j('e', 'error'), j('f', 'skipped'), j('h', 'passed', { tags: ['hook'] })];
    expect(js.map((x) => testState(x))).toEqual(['passed', 'healed', 'flaky', 'failed', 'error', 'skipped', 'passed']);
    const k = kpisOf(js, 5000);
    expect(k).toMatchObject({ total: 6, passed: 1, healed: 1, flaky: 1, failed: 1, errors: 1, skipped: 1 });
    expect(k.passRate).toBeCloseTo(3 / 5);
    expect(testState(j('x', 'passed'), new Set(['x']))).toBe('flaky');
  });

  it('builds the trend from history and marks this run', () => {
    const run = runOf([j('a', 'passed'), j('b', 'failed')], 'now', '2026-10-05T00:00:00.000Z');
    const t = trendFromHistory([
      { runId: 'h2', startedAt: '2026-10-03T00:00:00.000Z', outcomes: [{ journeyId: 'a', status: 'passed', durationMs: 10, attempt: 1 }, { journeyId: 'b', status: 'passed', durationMs: 10, attempt: 1 }], durationMs: 700, readiness: 'GO' },
      { runId: 'h1', startedAt: '2026-10-01T00:00:00.000Z', outcomes: [{ journeyId: 'a', status: 'failed', durationMs: 10, attempt: 1 }, { journeyId: 'a', status: 'passed', durationMs: 10, attempt: 2 }, { journeyId: 'b', status: 'skipped', durationMs: 0, attempt: 1 }] },
    ], run, kpisOf(run.journeys, 5000));
    expect(t.map((p) => [p.runId, p.passRate, p.durationMs, !!p.current])).toEqual([['h1', 1, 10, false], ['h2', 1, 700, false], ['now', 0.5, 5000, true]]);
    expect(t[1].readiness).toBe('GO');
  });

  it('reads the data row of a data-driven test', () => {
    expect(dataRowOf('Login [user=alice, role=admin]')).toEqual({ user: 'alice', role: 'admin' });
    expect(dataRowOf('Plain name [draft]')).toBeUndefined();
  });
});

describe('the report model of a realistic run', () => {
  it('has the verdict, KPIs against the previous run, trend, slowest tests, coverage and comparison', () => {
    const m = buildReportModel(rich.run, rich.insights);
    expect(m.format).toBe('eztest-report-model');
    expect(m.verdict).toMatchObject({ decision: 'NO_GO', source: 'policy' });
    expect(m.verdict.reasons.some((r) => r.kind === 'violation' && r.tests.includes('checkout-card'))).toBe(true);
    expect(m.kpis).toMatchObject({ total: 20, failed: 4, errors: 1, flaky: 2, healed: 2, skipped: 2, passed: 9 });
    expect(m.previous?.runId).toBe('run-h14');
    expect(m.trend).toHaveLength(15);
    expect(m.trend[m.trend.length - 1].current).toBe(true);
    expect(m.slowest[0]).toMatchObject({ id: 'reports-sales' });
    expect(m.coverage.risk!.ratio).toBeGreaterThan(0.5);
    expect(m.coverage.requirements!.items.find((i) => i.id === '3440')).toMatchObject({ state: 'uncovered', title: 'Gift wrapping' });
    expect(m.coverage.requirements!.items.find((i) => i.id === '3412')).toMatchObject({ state: 'failing', url: 'https://dev.azure.com/contoso/Shop/_workitems/edit/3412' });
    expect(m.comparison).toMatchObject({ baselineRunId: 'run-2026-10-21-0800' });
    expect(m.comparison!.newlyFailing.map((x) => x.id).sort()).toEqual(['account-profile', 'api-orders']);
    expect(m.comparison!.added.map((x) => x.id)).toEqual(['db-inventory']);
    expect(m.comparison!.removed.map((x) => x.id)).toEqual(['checkout-legacy']);
    expect(m.comparison!.slower.map((x) => x.id)).toEqual(['reports-sales']);
  });

  it('groups failures by signature, marks known ones with the run they were first seen in, and clusters shared causes', () => {
    const m = buildReportModel(rich.run, rich.insights);
    const discount = m.failureGroups.find((g) => g.message.includes('discount applied twice'))!;
    expect(discount.tests.sort()).toEqual(['checkout-card', 'checkout-voucher']);
    expect(discount.known).toBe(false);
    const dup = m.failureGroups.find((g) => g.message.includes('UNIQUE constraint'))!;
    expect(dup).toMatchObject({ known: true, firstSeenRun: 'run-h11' });
    const card = m.tests.find((t) => t.id === 'checkout-card')!;
    const voucher = m.tests.find((t) => t.id === 'checkout-voucher')!;
    expect(card.cluster).toBeDefined();
    expect(card.cluster).toBe(voucher.cluster);
    expect(card.triage?.category).toBeDefined();
    expect(voucher.row).toEqual({ voucher: 'SAVE10', country: 'DE' });
  });

  it('builds a suite tree from folders (a file with one test is not a level), or from a runner suite path', () => {
    const m = buildReportModel(rich.run, rich.insights);
    expect(m.tests.find((t) => t.id === 'checkout-card')!.suite).toEqual(['checkout']);
    const bdd = runOf([j('s1', 'passed', { suitePath: [{ kind: 'feature', name: 'Checkout' }, { kind: 'rule', name: 'Vouchers' }] })]);
    expect(buildReportModel(bdd).tests[0].suite).toEqual(['Checkout', 'Vouchers']);
    const two = runOf([j('a', 'passed'), j('b', 'passed')]);
    expect(buildReportModel(two, { files: { a: 'journeys/shop/cart.ez', b: 'journeys/shop/cart.ez' } }).tests[0].suite).toEqual(['cart']);
    expect(buildReportModel(runOf([j('a', 'passed', { tags: ['@smoke'] })])).tests[0].suite).toEqual(['smoke']);
  });

  it('carries the step tree with heals, API exchanges, DB rows, diagnosis, network, console and attempts', () => {
    const m = buildReportModel(rich.run, { ...rich.insights, artifacts: undefined });
    const paypal = m.tests.find((t) => t.id === 'checkout-paypal')!;
    expect(paypal.steps[2].h).toMatchObject({ tier: 'T1-fingerprint', from: ['css=#btn-2'], verified: true });
    const db = m.tests.find((t) => t.id === 'db-inventory')!;
    expect(db.steps[1].db).toMatchObject({ key: 'reserved', columns: ['sku', 'warehouse', 'qty', 'reserved_at'], total: 2 });
    const profile = m.tests.find((t) => t.id === 'account-profile')!;
    expect(profile.steps[1].dg?.similar[0]).toContain('label=Given name');
    const split = m.tests.find((t) => t.id === 'checkout-split')!;
    expect(split.attempts!.map((a) => a.status)).toEqual(['failed', 'passed']);
    expect(split.flake?.cause).toBe('timing');
    expect(split.history?.sequence.length).toBeGreaterThan(5);
  });

  it('links Azure DevOps test cases, plan, suite, results and bugs, Jira bugs and requirements - and re-links after publishing', () => {
    const m = buildReportModel(rich.run, rich.insights);
    const card = m.tests.find((t) => t.id === 'checkout-card')!;
    expect(card.ado).toMatchObject({ testCases: [{ id: 1201, url: 'https://dev.azure.com/contoso/Shop/_workitems/edit/1201' }], plan: { id: 77 }, suite: { id: 88 } });
    expect(card.ado!.results[0].url).toBe('https://dev.azure.com/contoso/Shop/_testManagement/runs?_a=resultSummary&runId=4711&resultId=100000');
    expect(card.bugs).toEqual([{ system: 'ado', id: '5521', url: 'https://dev.azure.com/contoso/Shop/_workitems/edit/5521', action: 'created' }]);
    expect(m.tests.find((t) => t.id === 'account-profile')!.bugs[0]).toMatchObject({ system: 'jira', id: 'SHOP-982', url: 'https://contoso.atlassian.net/browse/SHOP-982' });
    expect(m.integrations.ado!.publish!.runUrl).toBe(adoWeb.testRun({ collectionUrl: 'https://dev.azure.com/contoso', project: 'Shop' }, 4711));
    expect(m.integrations.pullRequest).toMatchObject({ number: 318 });
    expect(m.integrations.git).toMatchObject({ branch: 'feature/checkout-v2', codeowners: true });
    // a model built before publishing has test case links but no results; after publishing it is patched
    const before = buildReportModel(rich.run, { ...rich.insights, integrations: undefined });
    expect(before.tests.find((t) => t.id === 'checkout-card')!.ado!.results).toEqual([]);
    applyIntegrationLinks(before, { integrations: rich.integrations, ...before.linkConfig });
    expect(before.tests.find((t) => t.id === 'checkout-card')!.ado!.results[0].resultId).toBe(100000);
    expect(before.integrations.ado!.publish!.status).toBe('partial');
  });

  it('never renders a non-http link from a record', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined();
    const m = buildReportModel(rich.run, { ...rich.insights, integrations: { ...rich.integrations, resultsServer: { url: 'javascript:alert(1)', at: 'x' }, ado: { ...rich.integrations.ado, bugs: [{ journeyId: 'checkout-card', id: 1, action: 'created', url: 'data:text/html,x' }] } } });
    expect(m.integrations.resultsServer).toBeUndefined();
    expect(m.tests.find((t) => t.id === 'checkout-card')!.bugs[0].url).toBe('https://dev.azure.com/contoso/Shop/_workitems/edit/1');
  });

  it('the run context reads Azure Pipelines, GitHub Actions and the git remote', () => {
    expect(rich.context).toMatchObject({ environment: 'staging', branch: 'feature/checkout-v2', build: { system: 'azure-pipelines', number: '20261022.4', url: 'https://dev.azure.com/contoso/Shop/_build/results?buildId=20931', reason: 'PullRequest' }, pullRequest: { number: 318 }, shard: { index: 1, total: 2 }, user: 'Ada Lovelace', timeZone: 'Europe/Berlin' });
    const gh = buildRunContext(runOf([j('a', 'passed')]), { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/shop', GITHUB_RUN_ID: '77', GITHUB_SHA: 'abc123def', GITHUB_REF: 'refs/pull/9/merge', GITHUB_HEAD_REF: 'fix/x', GITHUB_ACTOR: 'grace' });
    expect(gh).toMatchObject({ build: { system: 'github-actions', url: 'https://github.com/acme/shop/actions/runs/77' }, branch: 'fix/x', commit: { sha: 'abc123def', url: 'https://github.com/acme/shop/commit/abc123def' }, pullRequest: { number: 9, url: 'https://github.com/acme/shop/pull/9' }, user: 'grace' });
  });

  it('compares two runs', () => {
    const a = runOf([j('a', 'passed'), j('b', 'failed'), j('c', 'passed', { durationMs: 1000 }), j('gone', 'passed')]);
    const b = runOf([j('a', 'failed'), j('b', 'passed'), j('c', 'passed', { durationMs: 4000 }), j('new', 'passed')]);
    const c = compareRunResults(a, b);
    expect(c.newlyFailing.map((x) => x.id)).toEqual(['a']);
    expect(c.fixed.map((x) => x.id)).toEqual(['b']);
    expect(c.slower).toEqual([{ id: 'c', name: 'c', beforeMs: 1000, afterMs: 4000, ratio: 4 }]);
    expect(c.added.map((x) => x.id)).toEqual(['new']);
    expect(c.removed.map((x) => x.id)).toEqual(['gone']);
  });
});

describe('evidence, video and branding', () => {
  it('describes every evidence file: kind, link, size, time, SHA-256, chain position, test and step', () => {
    const m = buildReportModel(rich.run, rich.insights);
    const entries = Object.entries(m.evidence);
    expect(entries.length).toBeGreaterThan(0);
    for (const [, v] of entries) expect(v).toHaveLength(9);
    const ref = rich.insights.evidence!.find((r) => r.journeyId && r.stepId)!;
    const v = m.evidence[ref.id];
    expect(v[5]).toBe(ref.sha256 ?? '');
    expect(m.tests[v[7]].id).toBe(ref.journeyId);
    expect(v[8]).toBeGreaterThan(0);
  });

  it('explains a missing video from the video policy', () => {
    const run = runOf([j('a', 'passed'), j('b', 'failed')]);
    expect(buildReportModel(run, { videoPolicy: 'off' }).tests[0].videoNote).toContain('video: off');
    expect(buildReportModel(run, { videoPolicy: 'retain-on-failure' }).tests[0].videoNote).toContain('retain-on-failure');
  });

  it('masks credentials in request headers and URLs', () => {
    expect(maskHeaders({ Authorization: 'Bearer x', cookie: 'sid=1', accept: 'json' })).toEqual({ Authorization: '****', cookie: '****', accept: 'json' });
    expect(maskUrl('https://h/p?a=1&access_token=abc&api_key=k')).toBe('https://h/p?a=1&access_token=****&api_key=****');
  });

  it('brand colour: the mark gets readable text, bad values are ignored', () => {
    expect(brandCss('#0f766e')).toContain('color:#ffffff');
    expect(brandCss('#ffe066')).toContain('color:#141413');
    expect(brandCss('red')).toBe('');
    expect(brandCss(undefined)).toBe('');
  });

  it('the default title and name come from package.json, else the folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eztest-brand-'));
    const a = join(root, 'my_shop-tests');
    await mkdir(a);
    expect(projectName(a)).toBe('My shop tests');
    const b = join(root, 'b');
    await mkdir(b);
    await writeFile(join(b, 'package.json'), JSON.stringify({ name: '@acme/contoso-web' }));
    expect(projectName(b)).toBe('Contoso web');
  });
});

describe('exports', () => {
  it('report.json validates against the published JSON Schema', () => {
    const m = buildReportModel(rich.run, rich.insights);
    const ajv = new (Ajv2020 as unknown as typeof import('ajv').default)({ strict: false, allErrors: true });
    const validate = ajv.compile(REPORT_JSON_SCHEMA as object);
    const doc = JSON.parse(JSON.stringify(buildJsonReport(rich.run, rich.insights, m)));
    expect(validate(doc), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
    doc.model.tests[0].state = 'weird';
    expect(validate(doc)).toBe(false);
  });

  it('CSV quotes cells and neutralises spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-1')).toBe("'-1");
    const csv = renderTestsCsv(buildReportModel(rich.run, rich.insights));
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(21);
    expect(lines[0].split(',').slice(0, 4)).toEqual(['id', 'name', 'state', 'status']);
    expect(lines.find((l) => l.startsWith('checkout-voucher'))).toContain('voucher=SAVE10; country=DE');
  });

  it('the Teams adaptive card and the Slack message summarise the run and link the report, ADO run, build and PR', () => {
    const m = buildReportModel(rich.run, rich.insights);
    const links = cardLinks(m, { reportUrl: 'https://ci.example/artifacts/report.html' });
    expect(links).toEqual({ report: 'https://ci.example/artifacts/report.html', adoRun: m.integrations.ado!.publish!.runUrl, build: 'https://dev.azure.com/contoso/Shop/_build/results?buildId=20931', pullRequest: 'https://dev.azure.com/contoso/Shop/_git/shop-web/pullrequest/318' });
    const card = buildTeamsCard(m, links) as { type: string; version: string; msteams: unknown; body: Array<Record<string, any>>; actions: Array<Record<string, string>> };
    expect(card).toMatchObject({ type: 'AdaptiveCard', version: '1.5', msteams: { width: 'Full' } });
    expect(card.body[0]).toMatchObject({ type: 'Container', style: 'attention' });
    expect(card.body[0].items[2].text).toBe('NO GO — 5 of 20 tests failed');
    const kpis = card.body.find((b) => b.type === 'ColumnSet')!;
    expect(kpis.columns.map((c: any) => c.items[1].text)).toEqual(['Tests', 'Passed', 'Failed', 'Flaky', 'Pass rate']);
    expect(card.body.find((b) => b.type === 'FactSet')!.facts).toEqual(expect.arrayContaining([{ title: 'Branch', value: 'feature/checkout-v2' }]));
    const failures = card.body.find((b) => b.type === 'Container' && b.items?.[0]?.text?.startsWith('Top failures'))!;
    expect(failures.items[1].selectAction.url).toMatch(/report\.html#test\/(checkout-card|checkout-voucher|api-orders)$/);
    expect(card.actions.map((a) => a.title)).toEqual(['Open the report', 'Azure DevOps test run', 'Build', 'Pull request']);
    for (const a of card.actions) expect(a.type).toBe('Action.OpenUrl');
    const slack = buildSlackMessage(m, links) as { text: string; blocks: Array<Record<string, any>> };
    expect(slack.text).toContain('NO GO');
    expect(slack.blocks.find((b) => b.type === 'actions')!.elements).toHaveLength(4);
    expect(JSON.stringify(slack.blocks)).toContain('<https://ci.example/artifacts/report.html#test/');
  });
});

describe('charts', () => {
  it('nice ticks, duration formatting and bins', () => {
    expect(niceTicks(87)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(fmtMs(450)).toBe('450 ms');
    expect(fmtMs(4500)).toBe('4.5 s');
    expect(fmtMs(125_000)).toBe('2 min 5 s');
    const bins = durationBins([100, 800, 1500, 1600, 70_000]);
    expect(bins.map((b) => b.value).slice(0, 4)).toEqual([1, 1, 2, 0]);
    expect(bins.reduce((n, b) => n + b.value, 0)).toBe(5);
  });

  it('donut: one path per non-empty segment with a tooltip, a legend with counts and a data table', () => {
    const svg = donutChart([{ key: 'passed', label: 'Passed', value: 3 }, { key: 'failed', label: 'Failed', value: 1 }, { key: 'skipped', label: 'Skipped', value: 0 }], { title: 'Outcome', centre: '75%', centreLabel: 'pass rate' });
    expect(svg.match(/<path class="mark /g)).toHaveLength(2);
    expect(svg).toContain('data-tip="Passed: 3 (75.0%)"');
    expect(svg).toMatch(/<title id="\w+-t">Outcome<\/title><desc id="\w+-d">Passed 3, Failed 1, Skipped 0\. Total 4\.<\/desc>/);
    expect(svg).toContain('<caption>Outcome</caption>');
    expect(svg).toContain('<span class="lk">Skipped</span><span class="lv">0</span>');
    // single segment: a full ring
    expect(donutChart([{ key: 'passed', label: 'Passed', value: 5 }], { title: 't', centre: '100%', centreLabel: '' })).toContain('fill-rule="evenodd"');
  });

  it('line, columns, bars and heat map have axes, labels and escaped text', () => {
    const line = lineChart([{ label: 'a', value: 0.5 }, { label: 'b<', value: 1, current: true }], { title: 'Pass rate', yMax: 1, yFormat: (v) => `${v * 100}%`, series: 'series-1' });
    expect(line).toContain('class="line series-1"');
    expect(line).toContain('>100%</text>');
    expect(line).toContain('b&lt;');
    expect(line).toContain('(this run)');
    const col = columnChart([{ label: 'x', value: 4 }, { label: 'y', value: 0 }], { title: 'C', yLabel: 'bin' });
    expect(col.match(/<path class="mark/g)).toHaveLength(1);
    const hb = hbarChart([{ label: 'slow <test>', value: 9000, valueLabel: '9.0 s', href: '#test/x' }], { title: 'Slowest', unit: 'Duration' });
    expect(hb).toContain('slow &lt;test&gt;');
    expect(hb).toContain('href="#test/x"');
    expect(hb).toMatch(/role="group"/); // has links: a group, not a presentational image
    const hm = heatmap(['suite'], ['10-01', '10-02'], [[{ rate: 0.6, n: 5 }, null]], { title: 'Heat', valueLabel: 'failure rate' });
    expect(hm).toContain('class="cell q4"');
    expect(hm).toContain('class="cell none"');
    expect(hm).toContain('60.0% of 5');
  });

  it('assigns parallel lanes from overlapping spans', () => {
    const lanes = assignLanes([{ id: 'a', label: 'a', start: 0, end: 10, cls: '' }, { id: 'b', label: 'b', start: 5, end: 12, cls: '' }, { id: 'c', label: 'c', start: 10, end: 20, cls: '' }]);
    expect(lanes.map((l) => l.map((s) => s.id))).toEqual([['a', 'c'], ['b']]);
  });
});
