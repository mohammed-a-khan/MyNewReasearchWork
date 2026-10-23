/**
 * Security findings: response headers, cookies and mixed content from the
 * security lens (severity and remediation), plus the authorization matrix and
 * IDOR probes run on the server with role tokens that never reach the browser.
 */
import { api } from '../core/api.js';
import { add, clear, h, uid } from '../core/dom.js';
import { link, navigate } from '../core/router.js';
import { button, card, emptyState } from '../ui/badge.js';
import { confirmDialog } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { dataTable, field, pageHeader, runPicker, sevBadge, withStates, type SubPageDef } from './assurance-ui.js';

interface SecFinding {
  id: string;
  severity: string;
  message: string;
  url: string;
  subject?: string;
  category: 'headers' | 'cookies' | 'mixed-content';
  remediation: string;
  steps: string[];
}

const SEV_ORDER = ['high', 'medium', 'low', 'info'];
const CATEGORY: Record<string, string> = { headers: 'Response headers', cookies: 'Cookies', 'mixed-content': 'Mixed content' };

export async function mountSecurityRun(el: HTMLElement, runId: string): Promise<void> {
  const r = await withStates(el, () => api.get<{ scannedSteps: number; findings: SecFinding[] }>(`/api/assurance/security/runs/${encodeURIComponent(runId)}`), { retry: () => void mountSecurityRun(el, runId) });
  if (!r) return;
  if (!r.scannedSteps) {
    el.appendChild(emptyState('No security scans', 'Run with the security lens ("lenses: [security]") to check headers, cookies and mixed content after every step.'));
    return;
  }
  const counts = SEV_ORDER.map((s) => `${r.findings.filter((f) => f.severity === s).length} ${s}`).join(' · ');
  el.appendChild(h('p', { class: 'muted', text: `${r.findings.length} distinct finding(s) over ${r.scannedSteps} scanned step(s): ${counts}` }));
  for (const cat of ['headers', 'cookies', 'mixed-content']) {
    const list = r.findings.filter((f) => f.category === cat).sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
    el.appendChild(card(`${CATEGORY[cat]} (${list.length})`, dataTable<SecFinding>({
      caption: CATEGORY[cat],
      rows: list,
      empty: 'No findings.',
      rowAttrs: (f) => ({ dataset: { finding: f.id } }),
      columns: [
        { title: 'Severity', render: (f) => sevBadge(f.severity) },
        { title: 'Finding', render: (f) => h('div', null, h('strong', { text: f.message }), h('div', { class: 'small muted' }, h('code', { text: f.id }), f.subject ? ` · ${f.subject}` : '')) },
        { title: 'URL', render: (f) => h('code', { class: 'small', text: f.url }) },
        { title: 'Remediation', render: (f) => h('p', { class: 'small', text: f.remediation }) },
        { title: 'Seen at', render: (f) => h('span', { class: 'small muted', text: `${f.steps.length} step(s): ${f.steps.slice(0, 2).join('; ')}${f.steps.length > 2 ? '…' : ''}` }) },
      ],
    })));
  }
}

interface Setup {
  roles: Array<{ name: string; api: boolean }>;
  baseUrl?: string;
  matrix?: { roles?: string[]; cases?: Array<{ name?: string; method?: string; path: string; expect: Record<string, 'allow' | 'deny'> }> };
  matrixFile: string;
}

interface CaseRow {
  name: string;
  method: string;
  path: string;
  expect: Record<string, 'allow' | 'deny'>;
}

function authzCard(setup: Setup): HTMLElement {
  const usable = setup.roles.filter((r) => r.api);
  let roles = (setup.matrix?.roles ?? usable.map((r) => r.name)).filter((r) => usable.some((u) => u.name === r));
  let cases: CaseRow[] = (setup.matrix?.cases ?? [{ name: 'List orders', method: 'GET', path: '/api/orders', expect: {} }]).map((c) => ({ name: c.name ?? '', method: c.method ?? 'GET', path: c.path, expect: { ...c.expect } }));
  const rolesBox = h('fieldset', { class: 'fs row wrap' }, h('legend', { text: 'Roles (API tokens resolved on the server)' }));
  const editor = h('div');
  const result = h('div', { 'aria-live': 'polite' });
  const renderRoles = () => {
    clear(rolesBox).appendChild(h('legend', { text: 'Roles (API tokens resolved on the server)' }));
    for (const r of usable) {
      const id = uid('role');
      const input = h('input', { type: 'checkbox', id, checked: roles.includes(r.name), onchange: () => ((roles = input.checked ? [...roles, r.name] : roles.filter((x) => x !== r.name)), renderEditor()) });
      rolesBox.appendChild(h('label', { class: 'check', for: id }, input, h('span', { text: r.name })));
    }
    for (const r of setup.roles.filter((x) => !x.api)) rolesBox.appendChild(h('span', { class: 'small muted', text: `${r.name} (no API credentials)` }));
  };
  const renderEditor = () => {
    clear(editor).append(h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' },
      h('caption', { class: 'sr-only', text: 'Authorization cases' }),
      h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Name' }), h('th', { scope: 'col', text: 'Method' }), h('th', { scope: 'col', text: 'Path' }), roles.map((r) => h('th', { scope: 'col', text: r })), h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: 'Remove' })))),
      h('tbody', null, cases.map((c, i) => h('tr', null,
        h('td', null, h('input', { class: 'input input-sm', value: c.name, 'aria-label': `Case ${i + 1} name`, oninput: (e: Event) => (c.name = (e.target as HTMLInputElement).value) })),
        h('td', null, h('select', { class: 'input input-sm', 'aria-label': `Case ${i + 1} method`, onchange: (e: Event) => (c.method = (e.target as HTMLSelectElement).value) }, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => h('option', { value: m, text: m, selected: m === c.method })))),
        h('td', null, h('input', { class: 'input input-sm mono-input', value: c.path, 'aria-label': `Case ${i + 1} path`, oninput: (e: Event) => (c.path = (e.target as HTMLInputElement).value) })),
        roles.map((r) => {
          c.expect[r] ??= 'allow';
          return h('td', null, h('select', { class: 'input input-sm', 'aria-label': `Case ${i + 1}: expected for ${r}`, onchange: (e: Event) => (c.expect[r] = (e.target as HTMLSelectElement).value as 'allow' | 'deny') }, ['allow', 'deny'].map((v) => h('option', { value: v, text: v, selected: c.expect[r] === v }))));
        }),
        h('td', null, button('Remove', { small: true, kind: 'ghost', icon: 'trash', ariaLabel: `Remove case ${i + 1}`, onclick: () => ((cases = cases.filter((x) => x !== c)), renderEditor()) }))))))),
      h('div', { class: 'row' }, button('Add case', { small: true, icon: 'plus', onclick: () => (cases.push({ name: '', method: 'GET', path: '/', expect: {} }), renderEditor()) })));
  };
  const payload = () => ({ roles, cases: cases.map((c) => ({ ...c, expect: Object.fromEntries(roles.map((r) => [r, c.expect[r] ?? 'allow'])) })) });
  const run = async () => {
    const r = await withStates(result, () => api.post<{ passed: boolean; results: Array<{ case: string; role: string; method: string; path: string; expected: string; actual: string; status: number; violation: boolean; severity: string; remediation?: string }>; violations: unknown[] }>('/api/assurance/security/authz', payload()), { loading: 'Probing every role × case…' });
    if (!r) return;
    const names = [...new Set(r.results.map((x) => x.case))];
    add(result,
      h('p', null, sevBadge(r.passed ? 'pass' : 'fail', r.passed ? 'No violations' : `${r.violations.length} violation(s)`)),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table compact matrix' },
        h('caption', { class: 'sr-only', text: 'Authorization matrix results' }),
        h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Case' }), roles.map((ro) => h('th', { scope: 'col', text: ro })))),
        h('tbody', null, names.map((n) => h('tr', null, h('th', { scope: 'row', text: n }), roles.map((ro) => {
          const x = r.results.find((y) => y.case === n && y.role === ro);
          if (!x) return h('td');
          return h('td', { class: x.violation ? 'cell-violation' : 'cell-ok', title: x.remediation ?? '' }, x.violation ? `VIOLATION: expected ${x.expected}, got ${x.actual} (${x.status || 'no response'})` : `${x.actual} (${x.status})`);
        })))))),
      r.results.some((x) => x.violation) ? h('ul', { class: 'bullets bad-text' }, r.results.filter((x) => x.violation).map((x) => h('li', null, sevBadge(x.severity), ` ${x.role} ${x.method} ${x.path}: ${x.remediation ?? ''}`))) : null,
    );
  };
  const save = async () => {
    if (!(await confirmDialog({ title: 'Save the matrix?', message: `Write ${setup.matrixFile} in the project?`, confirm: 'Save' }))) return;
    try {
      await api.put('/api/assurance/security/matrix', payload());
      toast(`Saved ${setup.matrixFile}`, { kind: 'success' });
    } catch (e) {
      toastError((e as Error).message);
    }
  };
  renderRoles();
  renderEditor();
  return card('Authorization matrix', h('div', { class: 'stack' },
    h('p', { class: 'muted', text: `Each selected role calls each case against ${setup.baseUrl ?? 'the configured baseUrl'}; a deny that is allowed is a high-severity violation. "anonymous" sends no token.` }),
    rolesBox, editor,
    h('div', { class: 'row' }, button('Run matrix', { kind: 'primary', icon: 'run', onclick: () => void run() }), button('Save matrix', { icon: 'save', onclick: () => void save() })),
    result), { id: 'authz' });
}

function idorCard(setup: Setup): HTMLElement {
  const usable = setup.roles.filter((r) => r.api);
  const user = (n: number) => {
    const role = h('select', { class: 'input' }, usable.map((r, i) => h('option', { value: r.name, text: r.name, selected: i === (n - 1) % Math.max(1, usable.length) })));
    const res = h('textarea', { class: 'input mono-input', rows: 3, placeholder: '/api/orders/1' });
    return { role, res, el: h('div', { class: 'stack-sm' }, field(`Role ${n}`, role), field(`Resources owned by role ${n} (one path per line)`, res)) };
  };
  const a = user(1);
  const b = user(2);
  const out = h('div', { 'aria-live': 'polite' });
  const run = async () => {
    const r = await withStates(out, () => api.post<{ vulnerable: boolean; findings: Array<{ path: string; owner: string; requester: string; ownerStatus: number; requesterStatus: number; verdict: string; remediation?: string }> }>('/api/assurance/security/idor', { users: [a, b].map((u) => ({ role: u.role.value, resources: u.res.value.split('\n').map((x) => x.trim()).filter(Boolean) })) }), { loading: 'Probing…' });
    if (!r) return;
    out.append(h('p', null, sevBadge(r.vulnerable ? 'fail' : 'pass', r.vulnerable ? 'IDOR found' : 'No IDOR found')), dataTable({
      caption: 'IDOR probe results',
      rows: r.findings,
      columns: [
        { title: 'Resource', render: (f) => h('code', { text: f.path }) },
        { title: 'Owner', render: (f) => `${f.owner} (${f.ownerStatus})` },
        { title: 'Requested by', render: (f) => `${f.requester} (${f.requesterStatus})` },
        { title: 'Verdict', render: (f) => sevBadge(f.verdict === 'vulnerable' ? 'high' : f.verdict === 'protected' ? 'ok' : 'warn', f.verdict) },
        { title: 'Remediation', render: (f) => h('span', { class: 'small', text: f.remediation ?? '' }) },
      ],
    }));
  };
  return card('IDOR probe', h('div', { class: 'stack' }, h('p', { class: 'muted', text: 'Each role requests the other role\'s resources. Access to a resource its owner can read is reported as vulnerable.' }), h('div', { class: 'two-col' }, a.el, b.el), h('div', null, button('Run probe', { kind: 'primary', icon: 'run', onclick: () => void run() })), out), { id: 'idor' });
}

export const securitySection: SubPageDef = {
  id: 'security',
  title: 'Security',
  icon: 'lock',
  description: 'Headers, cookies, authorization, IDOR',
  mount(root) {
    const body = h('div', { class: 'stack' });
    const probes = h('div', { class: 'stack' });
    const picker = runPicker({ label: 'Run', lens: 'security', onChange: (id) => navigate(link('assurance', 'security', id)) });
    root.appendChild(h('div', { class: 'page-inner stack' }, pageHeader('Security', 'Findings of the security lens with severity and remediation, and authorization probes run with real role tokens on the server.', picker.el), body, probes));
    let probesLoaded = false;
    return {
      show: async (segs) => {
        const runId = await picker.set(segs[0]);
        if (!runId) clear(body).appendChild(emptyState('No security scans yet', 'Add "security" to the lenses and run a journey to check headers, cookies and mixed content after every step.'));
        else {
          clear(body);
          await mountSecurityRun(body, runId);
        }
        if (!probesLoaded) {
          probesLoaded = true;
          const s = await withStates(probes, () => api.get<Setup>('/api/assurance/security/setup'));
          if (s) probes.append(authzCard(s), idorCard(s));
        }
      },
    };
  },
};
