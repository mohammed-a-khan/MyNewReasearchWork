/**
 * Project › API contracts (OpenAPI specs with lint results, API coverage of a
 * run per operation, EZTest contract files, contract verification and can-release results)
 * and Project › Messages (what a run published to and received from its
 * message brokers, masked).
 */
import { api } from '../core/api.js';
import { clear, h } from '../core/dom.js';
import { card, emptyState, stat } from '../ui/badge.js';
import { codeBlock, dataTable, lineChart, pageHeader, runPicker, sevBadge, withStates, type SubPageDef } from './assurance-ui.js';

interface OperationCoverage {
  id: string;
  method: string;
  path: string;
  covered: boolean;
  calls: number;
  statuses: { covered: string[]; missing: string[]; undocumented: number[] };
  parameters: { missing: string[] };
  violations: number;
}
interface CoverageReport {
  spec: { file: string; title: string; version: string };
  totals: { operations: number; coveredOperations: number; operationRatio: number; statusCodes: number; coveredStatusCodes: number; statusRatio: number; parameters: number; coveredParameters: number; parameterRatio: number; calls: number; unmatchedCalls: number; violations: number };
  operations: OperationCoverage[];
  unmatched: Array<{ method: string; url: string; status?: number }>;
}
interface ContractsView {
  specs: Array<{ file: string; title?: string; version?: string; openapi?: string; operations?: number; lint?: { error: number; warning: number; info: number }; findings?: Array<{ rule: string; severity: string; where: string; message: string }>; error?: string }>;
  contracts: Array<{ file: string; consumer?: string; provider?: string; expectations?: Array<{ description: string; kind: string; request: string; status?: number; states: string[] }>; error?: string }>;
  server?: {
    url: string;
    project: string;
    error?: string;
    contracts?: Array<{ consumer: string; provider: string; consumerVersion: string; branch?: string; hash: string; publishedAt: string }>;
    verifications?: Array<{ consumer: string; provider: string; providerVersion: string; providerBranch?: string; consumerVersion?: string; passed: boolean; failed?: string[]; verifiedAt: string }>;
    releases?: Array<{ app: string; environment: string; version: string; releasedAt: string; releasedBy?: string }>;
  };
  run?: { runId: string; recorded: boolean; coverage: CoverageReport[]; results?: { verifications: Array<{ consumer: string; provider: string; passed: boolean; failed: string[] }>; canRelease?: { releasable: boolean; reason: string; app: string; version: string; environment: string } } };
  trend: Array<{ runId: string; startedAt?: string; ratio: number }>;
}

const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;

function coverageCard(r: CoverageReport): HTMLElement {
  const t = r.totals;
  return card(`API coverage: ${r.spec.title || r.spec.file}`, h('div', { class: 'stack' },
    h('div', { class: 'stats' },
      stat(`${t.coveredOperations}/${t.operations}`, `operations (${pct(t.operationRatio)})`, t.operationRatio < 0.8 ? 'warn' : 'ok'),
      stat(`${t.coveredStatusCodes}/${t.statusCodes}`, `status codes (${pct(t.statusRatio)})`),
      stat(`${t.coveredParameters}/${t.parameters}`, `parameters (${pct(t.parameterRatio)})`),
      stat(t.violations, 'contract violations', t.violations ? 'bad' : 'ok'),
      stat(t.unmatchedCalls, 'calls not in the spec', t.unmatchedCalls ? 'warn' : undefined)),
    dataTable<OperationCoverage>({
      caption: 'Operations',
      columns: [
        { title: 'Operation', render: (o) => h('span', null, h('code', { text: `${o.method} ${o.path}` }), ' ', h('span', { class: 'muted', text: o.id })) },
        { title: 'Covered', render: (o) => sevBadge(o.covered ? 'pass' : 'warning', o.covered ? `${o.calls} call(s)` : 'untested') },
        { title: 'Statuses covered', render: (o) => o.statuses.covered.join(', ') || '-' },
        { title: 'Statuses missing', render: (o) => o.statuses.missing.join(', ') || '-' },
        { title: 'Undocumented', render: (o) => o.statuses.undocumented.join(', ') || '-' },
        { title: 'Parameters missing', render: (o) => o.parameters.missing.join(', ') || '-' },
        { title: 'Violations', render: (o) => (o.violations ? sevBadge('error', String(o.violations)) : '0') },
      ],
      rows: r.operations,
    }),
    r.unmatched.length ? h('div', null, h('h3', { text: 'Calls not described by the spec' }), h('ul', { class: 'bullets' }, r.unmatched.map((u) => h('li', null, h('code', { text: `${u.method} ${u.url}` }), u.status !== undefined ? ` -> ${u.status}` : '')))) : h('span')));
}

export const contractsSection: SubPageDef = {
  id: 'contracts',
  title: 'API contracts',
  icon: 'certificate',
  description: 'OpenAPI coverage, contracts, can-release',
  mount(root) {
    const body = h('div', { class: 'stack' });
    let runId: string | undefined;
    const picker = runPicker({ label: 'Run', onChange: (id) => {
      runId = id;
      void load();
    } });
    root.appendChild(h('div', { class: 'page-inner stack' }, pageHeader('API contracts', 'The OpenAPI specs in api.spec and how much of them runs exercised (operations, status codes, parameters), contract violations, the EZTest contract files in the project, contract verification / can-release results recorded for a run, and the contracts, verifications and releases on the results server.', picker.el), body));
    const load = async () => {
      const v = await withStates(body, () => api.get<ContractsView>(`/api/project/contracts${runId ? `?run=${encodeURIComponent(runId)}` : ''}`), { retry: () => void load() });
      if (!v) return;
      clear(body);
      if (!v.specs.length && !v.contracts.length) {
        body.appendChild(emptyState('No contracts yet', 'Set api.spec in eztest.config.yaml to validate every API step against an OpenAPI spec, or start a contract in a journey ("Start a contract between consumer "web" and provider "api"").'));
        return;
      }
      body.append(card('Specs', dataTable({
        caption: 'Specs',
        columns: [
          { title: 'File', render: (s: ContractsView['specs'][number]) => h('code', { text: s.file }) },
          { title: 'API', render: (s) => (s.error ? sevBadge('error', s.error) : `${s.title ?? ''} ${s.version ?? ''} (OpenAPI ${s.openapi ?? '?'})`) },
          { title: 'Operations', render: (s) => String(s.operations ?? '-') },
          { title: 'Lint', render: (s) => (s.lint ? h('span', null, sevBadge(s.lint.error ? 'error' : 'pass', `${s.lint.error} error(s)`), ' ', `${s.lint.warning} warning(s)`) : '-') },
        ],
        rows: v.specs,
        empty: 'No api.spec configured.',
      })));
      for (const s of v.specs.filter((x) => x.findings?.length)) {
        body.append(card(`Lint findings: ${s.file}`, dataTable({ caption: 'Lint findings', columns: [{ title: 'Severity', render: (f: NonNullable<typeof s.findings>[number]) => sevBadge(f.severity) }, { title: 'Rule', render: (f) => f.rule }, { title: 'Where', render: (f) => h('code', { text: f.where }) }, { title: 'Finding', render: (f) => f.message }], rows: s.findings! })));
      }
      if (v.run) {
        if (!v.run.coverage.length) body.append(h('p', { class: 'muted', text: `Run ${v.run.runId} has no API coverage (no api.spec, or no API steps).` }));
        else if (!v.run.recorded) body.append(h('p', { class: 'note', text: `Coverage for run ${v.run.runId} was computed now from its evidence; runs with api.spec configured record it themselves.` }));
        for (const r of v.run.coverage) body.append(coverageCard(r));
        const res = v.run.results;
        if (res) {
          body.append(card('Contract verification and can-release', h('div', { class: 'stack' },
            dataTable({ caption: 'Verifications', columns: [{ title: 'Contract', render: (x: typeof res.verifications[number]) => `${x.consumer} -> ${x.provider}` }, { title: 'Result', render: (x) => sevBadge(x.passed ? 'pass' : 'fail', x.passed ? 'verified' : 'failed') }, { title: 'Failures', render: (x) => x.failed.join('; ') || '-' }], rows: res.verifications, empty: 'No verification recorded.' }),
            res.canRelease ? h('p', null, sevBadge(res.canRelease.releasable ? 'pass' : 'fail', res.canRelease.releasable ? 'can release' : 'cannot release'), ` ${res.canRelease.app} ${res.canRelease.version} to ${res.canRelease.environment}: ${res.canRelease.reason}`) : h('span'))));
        }
      }
      if (v.trend.length > 1) body.append(card('Operation coverage over runs', lineChart(v.trend.map((t) => ({ x: t.startedAt ?? t.runId, y: Math.round(t.ratio * 1000) / 10 })), { label: 'Operation coverage', unit: '%', threshold: 80 })));
      body.append(card('Contract files', v.contracts.length
        ? h('div', { class: 'stack' }, v.contracts.map((p) => p.error
          ? h('p', null, h('code', { text: p.file }), ' ', sevBadge('error', p.error))
          : h('div', null, h('h3', null, `${p.consumer} -> ${p.provider} `, h('span', { class: 'muted', text: `(${p.file})` })),
            dataTable({ caption: `Expectations of ${p.file}`, columns: [{ title: 'Expectation', render: (i: NonNullable<typeof p.expectations>[number]) => i.description }, { title: 'Kind', render: (i) => (i.kind === 'message' ? 'message' : 'HTTP') }, { title: 'Request or channel', render: (i) => h('code', { text: i.request }) }, { title: 'Status', render: (i) => (i.status === undefined ? '-' : String(i.status)) }, { title: 'Provider states', render: (i) => i.states.join(', ') || '-' }], rows: p.expectations ?? [] }))))
        : h('p', { class: 'muted', text: 'No contract files in the contracts directory yet.' })));
      const srv = v.server;
      if (srv) {
        const when = (t: string) => (t ? new Date(t).toLocaleString() : '-');
        body.append(card(`Results server: ${srv.project}`, srv.error
          ? h('p', null, sevBadge('error', 'unreachable'), ` ${srv.url}: ${srv.error}`)
          : h('div', { class: 'stack' },
            h('p', { class: 'muted', text: `Published contracts, verification results and releases on ${srv.url} (project ${srv.project}). eztest contracts can-release answers from these.` }),
            dataTable({ caption: 'Published contracts', columns: [
              { title: 'Consumer', render: (c: NonNullable<typeof srv.contracts>[number]) => `${c.consumer} ${c.consumerVersion}` }, { title: 'Branch', render: (c) => c.branch ?? '-' },
              { title: 'Provider', render: (c) => c.provider }, { title: 'Content', render: (c) => h('code', { text: c.hash.slice(0, 12) }) }, { title: 'Published', render: (c) => when(c.publishedAt) },
            ], rows: srv.contracts ?? [], empty: 'No contracts published yet (eztest contracts publish).' }),
            dataTable({ caption: 'Verification results', columns: [
              { title: 'Provider', render: (x: NonNullable<typeof srv.verifications>[number]) => `${x.provider} ${x.providerVersion}${x.providerBranch ? ` (${x.providerBranch})` : ''}` },
              { title: 'Consumer', render: (x) => `${x.consumer}${x.consumerVersion ? ` ${x.consumerVersion}` : ''}` },
              { title: 'Result', render: (x) => sevBadge(x.passed ? 'pass' : 'fail', x.passed ? 'verified' : 'failed') }, { title: 'Failures', render: (x) => x.failed?.join('; ') || '-' }, { title: 'Verified', render: (x) => when(x.verifiedAt) },
            ], rows: srv.verifications ?? [], empty: 'No verification results yet (eztest contracts verify --publish).' }),
            dataTable({ caption: 'Releases', columns: [
              { title: 'Application', render: (r: NonNullable<typeof srv.releases>[number]) => r.app }, { title: 'Environment', render: (r) => r.environment }, { title: 'Version', render: (r) => r.version },
              { title: 'Released', render: (r) => `${when(r.releasedAt)}${r.releasedBy ? ` by ${r.releasedBy}` : ''}` },
            ], rows: srv.releases ?? [], empty: 'Nothing released yet (eztest contracts record-release).' }))));
      }
    };
    return {
      show: () => {
        void picker.set(runId).then((id) => {
          runId = id;
          return load();
        });
      },
    };
  },
};

interface MessageRecord {
  evidenceId: string;
  journeyId?: string;
  stepId?: string;
  at?: string;
  description?: string;
  direction: 'published' | 'received';
  broker?: string;
  kind?: string;
  destination?: string;
  where?: string;
  key?: string;
  payload?: unknown;
  messages?: Array<{ destination: string; key?: string; correlationId?: string; payload: unknown; timestamp: string }>;
}

export const messagesSection: SubPageDef = {
  id: 'messages',
  title: 'Messages',
  icon: 'send',
  description: 'Kafka, RabbitMQ, MQTT, IBM MQ traffic of a run',
  mount(root) {
    const body = h('div', { class: 'stack' });
    let runId: string | undefined;
    const picker = runPicker({ label: 'Run', onChange: (id) => {
      runId = id;
      void load();
    } });
    root.appendChild(h('div', { class: 'page-inner stack' }, pageHeader('Messages', 'Every message a run published and every message its steps received, per journey step, as stored in evidence (secrets masked).', picker.el), body));
    const load = async () => {
      const v = await withStates(body, () => api.get<{ runId: string; messages: MessageRecord[] }>(`/api/project/messages${runId ? `?run=${encodeURIComponent(runId)}` : ''}`), { retry: () => void load() });
      if (!v) return;
      clear(body);
      if (!v.messages.length) {
        body.appendChild(emptyState('No messages in this run', 'Messaging steps ("Publish message ... to Kafka topic ...", "Wait for a message on ...") record what they sent and received here.'));
        return;
      }
      const rows = v.messages.flatMap((m) => (m.direction === 'received' && m.messages ? m.messages.map((x) => ({ ...m, destination: x.destination, key: x.key, payload: x.payload, at: x.timestamp })) : [m]));
      body.append(dataTable({
        caption: 'Messages',
        columns: [
          { title: 'Step', render: (m: MessageRecord) => h('span', null, m.journeyId ?? '', ' / ', h('code', { text: m.stepId ?? '' })) },
          { title: 'Direction', render: (m) => sevBadge(m.direction === 'published' ? 'info' : 'pass', m.direction) },
          { title: 'Where', render: (m) => `${m.kind ?? ''} ${m.destination ?? m.where ?? ''}`.trim() },
          { title: 'Key', render: (m) => m.key ?? '-' },
          { title: 'Payload', render: (m) => codeBlock(typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload, null, 2)) },
          { title: 'Evidence', render: (m) => m.evidenceId },
        ],
        rows,
      }));
    };
    return {
      show: () => {
        void picker.set(runId).then((id) => {
          runId = id;
          return load();
        });
      },
    };
  },
};
