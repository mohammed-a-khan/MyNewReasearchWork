/**
 * Renders the EZTest tab data (`eztest-tab.json`, written by `eztest ado
 * summary`) into the pipeline run's "EZTest" tab. Everything goes through
 * text nodes and attributes (no innerHTML), so report text cannot inject
 * markup into the Azure DevOps page.
 */

/** Tiny DOM builder: h('p', { class: 'x' }, 'text', child) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') el.textContent = String(v);
    else if (k === 'class') el.className = v;
    else if (k === 'href') {
      if (/^https?:\/\//i.test(String(v))) el.setAttribute('href', String(v));
    } else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

const LABEL = { GO: 'GO', GO_WITH_RISKS: 'GO with risks', NO_GO: 'NO GO' };
const STATUS = { passed: 'Passed', 'passed-healed': 'Passed with heals', failed: 'Failed', error: 'Error', skipped: 'Skipped' };

function ms(n) {
  return n >= 60000 ? `${(n / 60000).toFixed(1)} min` : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`;
}

function table(caption, head, rows) {
  return h('table', { class: 'ez-table' }, h('caption', { text: caption }), h('thead', null, h('tr', null, head.map((x) => h('th', { scope: 'col', text: x })))), h('tbody', null, rows));
}

export function renderMessage(root, title, text) {
  root.replaceChildren(h('section', { class: 'ez-empty' }, h('h1', { class: 'ez-h1', text: title }), h('p', { class: 'muted', text })));
  root.setAttribute('aria-busy', 'false');
}

/** Render one run's tab data. */
export function renderReport(root, data) {
  if (!data || data.format !== 'eztest-tab') {
    renderMessage(root, 'EZTest', 'This run has no EZTest report.');
    return;
  }
  const s = data.summary;
  const passed = s.passed + s.passedHealed;
  const where = [data.branch && `branch ${data.branch}`, data.commit && `commit ${data.commit.slice(0, 10)}`].filter(Boolean).join(', ');
  const parts = [
    h(
      'header',
      { class: `ez-head d-${data.decision}` },
      h('h1', { class: 'ez-h1' }, 'EZTest: ', h('span', { class: 'ez-decision', text: LABEL[data.decision] || data.decision })),
      h('p', { class: 'ez-sub', text: `${passed}/${s.total} journeys passed${s.passedHealed ? ` (${s.passedHealed} with heals)` : ''}${s.failed + s.errors ? `, ${s.failed + s.errors} failed` : ''}${s.skipped ? `, ${s.skipped} skipped` : ''}${data.score !== undefined ? ` · readiness score ${data.score}/100` : ''}${where ? ` · ${where}` : ''}` }),
      h('p', { class: 'muted small', text: `Run ${data.runId}, ${new Date(data.startedAt).toLocaleString()}` }),
    ),
  ];
  const gates = (data.gates || []).filter((g) => g.status !== 'pass');
  if (gates.length) {
    parts.push(h('section', { 'aria-labelledby': 'ez-gates' }, h('h2', { id: 'ez-gates', class: 'ez-h2', text: `Readiness gates not passing (${gates.length})` }), table('Readiness gates not passing', ['Gate', 'Status', 'Why'], gates.map((g) => h('tr', null, h('td', { text: g.gate }), h('td', { text: g.status }), h('td', { text: g.summary }))))));
  }
  if (data.failures.length) {
    parts.push(
      h(
        'section',
        { 'aria-labelledby': 'ez-fail' },
        h('h2', { id: 'ez-fail', class: 'ez-h2', text: `Failures (${data.failures.length})` }),
        table(
          'Failing journeys',
          ['Journey', 'Step', 'Error', 'Triage'],
          data.failures.map((f) =>
            h(
              'tr',
              null,
              h('td', null, h('strong', { text: f.name }), f.file ? h('div', { class: 'mono small', text: `${f.file}${f.line ? `:${f.line}` : ''}` }) : null),
              h('td', { text: f.step || '' }),
              h('td', null, h('pre', { class: 'ez-err', text: f.error })),
              h('td', { text: f.category ? `${f.category}${f.confidence !== undefined ? ` (${Math.round(f.confidence * 100)}%)` : ''}` : '' }),
            ),
          ),
        ),
      ),
    );
  }
  if (data.heals.length) {
    parts.push(
      h(
        'section',
        { 'aria-labelledby': 'ez-heal' },
        h('h2', { id: 'ez-heal', class: 'ez-h2', text: `Heals awaiting review (${data.heals.length})` }),
        h('p', { class: 'muted small', text: 'Accept or reject them in EZTest Studio (Quality > Heal review).' }),
        table(
          'Healed steps',
          ['Journey', 'Step', 'Locator', 'Tier', 'Verified'],
          data.heals.map((x) => h('tr', null, h('td', { text: x.name }), h('td', { text: x.step }), h('td', null, h('code', { text: x.from }), ' → ', h('code', { text: x.to })), h('td', { text: `${x.tier} ${Math.round(x.confidence * 100)}%` }), h('td', { text: x.verified ? 'yes' : 'no' }))),
        ),
      ),
    );
  }
  parts.push(
    h(
      'section',
      { 'aria-labelledby': 'ez-all' },
      h('h2', { id: 'ez-all', class: 'ez-h2', text: `Journeys (${data.journeys.length})` }),
      table('All journeys', ['Journey', 'Status', 'Duration', 'Attempt'], data.journeys.map((j) => h('tr', { class: `st-${j.status}` }, h('td', { text: j.name }), h('td', { text: STATUS[j.status] || j.status }), h('td', { text: ms(j.durationMs) }), h('td', { text: String(j.attempt) })))),
    ),
  );
  root.replaceChildren(...parts);
  root.setAttribute('aria-busy', 'false');
}
