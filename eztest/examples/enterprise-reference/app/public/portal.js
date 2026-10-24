/* Larkspur MyCover single-page app (plain browser JavaScript, no framework). */
(() => {
  'use strict';
  const main = document.getElementById('main');
  const toastEl = document.getElementById('toast');
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  const variant = document.querySelector('meta[name="ui-variant"]').content;
  let me = null;
  let pollTimer = null;
  let toastTimer = null;

  // ------------------------------------------------------------------ helpers
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v; // CSSOM: allowed by the CSP (style-src 'self'), unlike a style attribute
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const money = (n) => (n === null || n === undefined ? '-' : Number(n).toFixed(2));
  const fmtMoney = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = () => isoDate(new Date());
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const addDays = (d, n) => isoDate(new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000));
  const statusLabel = (s) => ({ SUBMITTED: 'Submitted', IN_REVIEW: 'In review', REFERRED: 'Referred', APPROVED: 'Approved', REJECTED: 'Rejected', SETTLEMENT_ACCEPTED: 'Settlement accepted', SETTLED: 'Settled' })[s] || s;

  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'x-csrf-token': csrf, ...(opts.json ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body });
    if (res.status === 401) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      throw new Error('signed out');
    }
    const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    if (!res.ok) throw new Error((body && body.message) || `request failed (${res.status})`);
    return body;
  }

  function toast(text) {
    clearTimeout(toastTimer);
    toastEl.textContent = text;
    toastEl.className = 'toast show';
    toastTimer = setTimeout(() => {
      toastEl.className = 'toast';
      toastEl.textContent = '';
    }, 6000);
  }

  function setView(title, ...content) {
    clearInterval(pollTimer);
    document.title = `${title} - MyCover`;
    main.replaceChildren(...present(content));
    main.focus({ preventScroll: true });
  }

  function present(list) {
    return list.filter((x) => x !== null && x !== undefined && x !== false);
  }

  function errorBox() {
    return h('div', { class: 'alert', role: 'alert', hidden: true });
  }
  function showError(box, msg) {
    box.textContent = msg;
    box.hidden = false;
  }

  // ------------------------------------------------------------------ router
  const routes = [
    [/^\/app\/?(home)?$/, homeView],
    [/^\/app\/quote$/, quoteView],
    [/^\/app\/claims\/new$/, newClaimView],
    [/^\/app\/claims$/, claimsView],
    [/^\/app\/claims\/(CLM-\d+)$/, claimView],
    [/^\/app\/settlement\/(CLM-\d+)$/, settlementView],
  ];
  function navigate(path, replace = false) {
    if (replace) history.replaceState({}, '', path);
    else history.pushState({}, '', path);
    render();
  }
  async function render() {
    const path = location.pathname;
    for (const [re, view] of routes) {
      const m = re.exec(path);
      if (m) {
        try {
          await view(...m.slice(1));
        } catch (e) {
          if (e.message !== 'signed out') setView('Error', h('section', { class: 'card' }, h('h1', { text: 'Something went wrong' }), h('p', { text: e.message })));
        }
        return;
      }
    }
    setView('Not found', h('section', { class: 'card' }, h('h1', { text: 'Page not found' })));
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (a && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      navigate(a.getAttribute('href'));
    }
  });
  window.addEventListener('popstate', render);

  async function loadMe() {
    me = await api('/bff/me');
    return me;
  }

  // ------------------------------------------------------------------ home
  async function homeView() {
    await loadMe();
    const now = today();
    const banners = me.policies
      .filter((p) => p.status === 'ACTIVE')
      .map((p) => ({ p, days: daysBetween(now, p.end_date) }))
      .filter((x) => x.days >= 0 && x.days <= 30)
      .map((x) => h('p', { class: 'banner', role: 'status', 'data-testid': `renewal-${x.p.id}` }, `Policy ${x.p.id} renews in ${x.days} day${x.days === 1 ? '' : 's'} (on ${x.p.end_date}).`));
    const expired = me.policies.filter((p) => p.status === 'ACTIVE' && p.end_date < now).map((p) => h('p', { class: 'alert', role: 'alert' }, `Policy ${p.id} expired on ${p.end_date}. Renew it to stay covered.`));
    setView(
      'Home',
      h('h1', { text: `Welcome, ${me.fullName}` }),
      h('p', { class: 'muted', 'data-testid': 'today' }, `Today is ${now}.`),
      ...banners,
      ...expired,
      h(
        'section',
        { class: 'card', 'aria-labelledby': 'policies-h' },
        h('h2', { id: 'policies-h', text: 'Your policies' }),
        h(
          'table',
          { 'aria-label': 'Your policies' },
          h('thead', {}, h('tr', {}, ['Policy', 'Product', 'Status', 'Sum insured', 'Excess', 'Renewal date'].map((t) => h('th', { scope: 'col', text: t })))),
          h(
            'tbody',
            {},
            me.policies.map((p) =>
              h('tr', {}, h('td', { text: p.id }), h('td', { text: p.product === 'HOME' ? 'Home' : 'Motor' }), h('td', { text: p.status === 'ACTIVE' ? 'Active' : 'Lapsed' }), h('td', { text: fmtMoney(p.sum_insured) }), h('td', { text: money(p.deductible) }), h('td', { text: p.end_date })),
            ),
          ),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ quote
  async function quoteView() {
    const err = errorBox();
    const riskLabel = h('label', { for: 'riskAge', text: 'Property age (years)' });
    const product = h('select', { id: 'product', name: 'product' }, h('option', { value: 'HOME', text: 'Home insurance' }), h('option', { value: 'MOTOR', text: 'Motor insurance' }));
    product.addEventListener('change', () => (riskLabel.textContent = product.value === 'HOME' ? 'Property age (years)' : 'Main driver age'));
    const region = h('select', { id: 'region', name: 'region' }, ['NORTH', 'SOUTH', 'COAST', 'METRO'].map((r) => h('option', { value: r, text: r[0] + r.slice(1).toLowerCase() })));
    const sum = h('input', { id: 'sumInsured', name: 'sumInsured', type: 'number', min: 1000, step: 'any', required: true });
    const age = h('input', { id: 'riskAge', name: 'riskAge', type: 'number', min: 0, required: true });
    const ncd = h('input', { id: 'noClaimsYears', name: 'noClaimsYears', type: 'number', min: 0, value: 0 });
    const result = h('section', { class: 'card', id: 'quote-result', 'aria-label': 'Quote result', hidden: true });
    const form = h(
      'form',
      { class: 'grid-form', 'aria-label': 'Quote details' },
      h('label', { for: 'product', text: 'Product' }), product,
      h('label', { for: 'sumInsured', text: 'Sum insured (GBP)' }), sum,
      h('label', { for: 'region', text: 'Region' }), region,
      riskLabel, age,
      h('label', { for: 'noClaimsYears', text: 'No-claims years' }), ncd,
      h('button', { type: 'submit', class: 'primary', text: 'Calculate premium' }),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      result.hidden = true;
      try {
        const q = await api('/bff/quotes', { method: 'POST', json: { product: product.value, sumInsured: Number(sum.value), region: region.value, riskAge: Number(age.value), noClaimsYears: Number(ncd.value || 0) } });
        const p = q.premium;
        const row = (label, id, value) => h('tr', {}, h('th', { scope: 'row', text: label }), h('td', { 'data-testid': id, text: value }));
        result.replaceChildren(
          h('h2', { id: 'breakdown-h', text: 'Premium breakdown' }),
          h('p', {}, 'Quote reference ', h('strong', { 'data-testid': 'quote-ref', text: q.quoteId })),
          h(
            'table',
            { 'aria-label': 'Premium breakdown' },
            h(
              'tbody',
              {},
              row('Base premium', 'base-premium', money(p.basePremium)),
              row('Region factor', 'region-factor', p.regionFactor.toFixed(2)),
              row('Risk loading', 'loading', `${p.loadingPct}%`),
              row('Loaded premium', 'loaded-premium', money(p.loadedPremium)),
              row('No-claims discount', 'ncd', `${p.noClaimsDiscountPct}%`),
              row('Discount', 'discount', money(p.discount)),
              row('Net premium', 'net-premium', money(p.netPremium)),
              row('Insurance premium tax (12%)', 'tax', money(p.tax)),
              row('Total annual premium', 'total-premium', money(p.totalPremium)),
            ),
          ),
        );
        result.hidden = false;
      } catch (ex) {
        showError(err, ex.message);
      }
    });
    setView('Get a quote', h('h1', { text: 'Get a quote' }), err, h('section', { class: 'card' }, form), result);
  }

  // ------------------------------------------------------------------ new claim
  async function newClaimView() {
    await loadMe();
    const err = errorBox();
    let declared = false;
    const active = me.policies.filter((p) => p.status === 'ACTIVE');
    const policy = h(
      'select',
      { id: 'policyId', name: 'policyId', required: true },
      h('option', { value: '', text: 'Choose a policy' }),
      me.policies.map((p) => h('option', { value: p.id, disabled: p.status !== 'ACTIVE', text: `${p.id} - ${p.product === 'HOME' ? 'Home' : 'Motor'}${p.status !== 'ACTIVE' ? ' (lapsed)' : ''}` })),
    );
    const types = { HOME: [['WATER', 'Water damage'], ['FIRE', 'Fire'], ['THEFT', 'Theft'], ['STORM', 'Storm'], ['GLASS', 'Glass']], MOTOR: [['COLLISION', 'Collision'], ['GLASS', 'Glass'], ['THEFT', 'Theft']] };
    const type = h('select', { id: 'type', name: 'type', required: true, disabled: true }, h('option', { value: '', text: 'Choose a policy first' }));
    const guide = h('a', { href: '/help/coverage?product=HOME', id: 'coverage-link', target: 'coverage' }, 'Coverage guide');
    guide.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(guide.href, 'coverage', 'popup,width=640,height=520');
    });
    policy.addEventListener('change', () => {
      const p = me.policies.find((x) => x.id === policy.value);
      type.replaceChildren(...(p ? [h('option', { value: '', text: 'Choose a claim type' }), ...types[p.product].map(([v, t]) => h('option', { value: v, text: t }))] : [h('option', { value: '', text: 'Choose a policy first' })]));
      type.disabled = !p;
      if (p) guide.href = `/help/coverage?product=${p.product}`;
    });
    const incident = h('input', { id: 'incidentDate', name: 'incidentDate', type: 'date', required: true, max: today() });
    const dateNote = h('p', { id: 'date-note', class: 'note', 'aria-live': 'polite' });
    incident.addEventListener('change', () => {
      const d = incident.value;
      dateNote.className = 'note';
      if (!d) return (dateNote.textContent = '');
      const ago = daysBetween(d, today());
      if (ago < 0) {
        dateNote.className = 'note error';
        dateNote.textContent = 'The incident date cannot be in the future.';
      } else if (ago > 30) {
        dateNote.className = 'note warn';
        dateNote.textContent = `Late notification: this incident happened ${ago} days ago. Claims reported more than 30 days after the incident take longer to assess.`;
      } else {
        dateNote.textContent = `Reporting deadline: ${addDays(d, 30)} (${30 - ago} days left).`;
      }
    });
    const amount = h('input', { id: 'amountClaimed', name: 'amountClaimed', type: 'number', min: 1, step: '0.01', required: true });
    const description = h('textarea', { id: 'description', name: 'description', rows: 4, required: true, 'aria-describedby': 'desc-hint' });
    const files = h('input', { id: 'evidence', name: 'evidence', type: 'file', multiple: true, accept: '.pdf,.png,.jpg,.jpeg,.txt' });
    const fileList = h('ul', { id: 'file-list', 'aria-label': 'Selected documents' });
    files.addEventListener('change', () => fileList.replaceChildren(...[...files.files].map((f) => h('li', { text: `${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB)` }))));
    const frame = h('iframe', { src: '/frames/declaration', title: 'Declaration', name: 'declaration', class: 'declaration' });
    window.addEventListener('message', (e) => {
      if (e.origin === location.origin && e.data && e.data.type === 'larkspur-declaration') declared = !!e.data.accepted;
    });
    const submit =
      variant === 'b'
        ? h('button', { type: 'submit', class: 'primary cta-file', id: 'file-claim-btn', text: 'File claim' })
        : h('button', { type: 'submit', class: 'primary', id: 'submit-claim', text: 'Submit claim' });
    const form = h(
      'form',
      { class: 'grid-form', 'aria-label': 'Claim details', novalidate: true },
      h('label', { for: 'policyId', text: 'Policy' }), policy,
      h('label', { for: 'type', text: 'Claim type' }), type,
      h('label', { for: 'incidentDate', text: 'Incident date' }), h('div', {}, incident, dateNote),
      h('label', { for: 'amountClaimed', text: 'Amount claimed (GBP)' }), amount,
      h('label', { for: 'description', text: 'What happened?' }), h('div', {}, description, h('p', { id: 'desc-hint', class: 'muted', text: 'At least 10 characters.' })),
      h('label', { for: 'evidence', text: 'Supporting documents' }), h('div', {}, files, fileList),
      submit,
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      if (!declared) return showError(err, 'Please confirm the declaration before you submit.');
      if (incident.value && incident.value > today()) return showError(err, 'The incident date cannot be in the future.');
      const fd = new FormData();
      for (const [k, el] of [['policyId', policy], ['type', type], ['incidentDate', incident], ['amountClaimed', amount], ['description', description]]) fd.append(k, el.value);
      fd.append('declaration', 'accepted');
      for (const f of files.files) fd.append('evidence', f, f.name);
      submit.disabled = true;
      try {
        const c = await api('/bff/claims', { method: 'POST', body: fd });
        navigate(`/app/claims/${c.claimId}`);
        toast(`Claim ${c.claimId} submitted. We sent a confirmation to ${me.email}.`);
      } catch (ex) {
        showError(err, ex.message);
        submit.disabled = false;
      }
    });
    setView(
      'Make a claim',
      h('h1', { text: 'Make a claim' }),
      active.length ? null : h('p', { class: 'alert', role: 'alert', text: 'You have no active policy to claim on.' }),
      err,
      h('p', {}, 'Not sure what is covered? Open the ', guide, '.'),
      h('section', { class: 'card' }, form),
      h('section', { class: 'card', 'aria-label': 'Declaration' }, frame),
    );
  }

  // ------------------------------------------------------------------ my claims (virtualized grid)
  async function claimsView() {
    const all = await api('/bff/claims');
    const cols = [
      ['claimId', 'Claim'],
      ['policyId', 'Policy'],
      ['type', 'Type'],
      ['incidentDate', 'Incident date'],
      ['amountClaimed', 'Amount'],
      ['status', 'Status'],
    ];
    const show = (r, k) => (k === 'amountClaimed' ? money(r[k]) : k === 'status' ? statusLabel(r[k]) : String(r[k]));
    const rowH = 36;
    const height = 360;
    let view = all;
    let sort = null;
    const count = h('p', { id: 'claim-count', role: 'status', 'aria-live': 'polite' });
    const search = h('input', { id: 'claim-search', type: 'search', placeholder: 'Claim, policy or type', 'aria-label': 'Search claims' });
    const statusFilter = h('select', { id: 'status-filter', 'aria-label': 'Status filter' }, h('option', { value: '', text: 'All statuses' }), ['SUBMITTED', 'IN_REVIEW', 'REFERRED', 'APPROVED', 'REJECTED', 'SETTLEMENT_ACCEPTED', 'SETTLED'].map((s) => h('option', { value: s, text: statusLabel(s) })));
    const grid = h('div', { role: 'grid', 'aria-label': 'My claims', 'aria-rowcount': all.length + 1, 'aria-colcount': cols.length, class: 'vgrid', 'data-testid': 'claims-grid' });
    const head = h('div', { role: 'row', 'aria-rowindex': 1, class: 'vgrid-head' });
    const viewport = h('div', { class: 'vgrid-viewport', style: `height:${height}px` });
    const spacer = h('div', { role: 'rowgroup', class: 'vgrid-body' });
    viewport.append(spacer);
    grid.append(h('div', { role: 'rowgroup' }, head), viewport);
    const drawHead = () =>
      head.replaceChildren(
        ...cols.map(([k, t], i) =>
          h(
            'div',
            { role: 'columnheader', 'aria-colindex': i + 1, 'aria-sort': sort && sort.k === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none', class: 'vgrid-cell' },
            h('button', { type: 'button', class: 'sort', onclick: () => {
              sort = !sort || sort.k !== k ? { k, dir: 1 } : sort.dir === 1 ? { k, dir: -1 } : null;
              apply();
            } }, t),
          ),
        ),
      );
    let last = '';
    const drawRows = (force) => {
      spacer.style.height = `${view.length * rowH}px`;
      const first = Math.max(0, Math.floor(viewport.scrollTop / rowH) - 4);
      const end = Math.min(view.length, Math.ceil((viewport.scrollTop + height) / rowH) + 4);
      const key = `${first}:${end}:${view.length}`;
      if (!force && key === last) return;
      last = key;
      spacer.replaceChildren(
        ...view.slice(first, end).map((r, j) => {
          const i = first + j;
          const row = h('div', { role: 'row', 'aria-rowindex': i + 2, class: 'vgrid-row', style: `top:${i * rowH}px;height:${rowH}px`, tabindex: -1 }, cols.map(([k], c) => h('div', { role: 'gridcell', 'aria-colindex': c + 1, class: 'vgrid-cell' }, c === 0 ? h('a', { href: `/app/claims/${r.claimId}`, 'data-link': true, text: r.claimId }) : show(r, k))));
          return row;
        }),
      );
    };
    const apply = () => {
      const q = search.value.trim().toLowerCase();
      const st = statusFilter.value;
      view = all.filter((r) => (!st || r.status === st) && (!q || cols.some(([k]) => show(r, k).toLowerCase().includes(q))));
      if (sort) view = [...view].sort((a, b) => (typeof a[sort.k] === 'number' ? a[sort.k] - b[sort.k] : String(a[sort.k]).localeCompare(String(b[sort.k]))) * sort.dir);
      grid.setAttribute('aria-rowcount', String(view.length + 1));
      count.textContent = `${view.length} claim${view.length === 1 ? '' : 's'}`;
      viewport.scrollTop = 0;
      drawHead();
      drawRows(true);
    };
    search.addEventListener('input', apply);
    statusFilter.addEventListener('change', apply);
    viewport.addEventListener('scroll', () => drawRows(false));
    setView('My claims', h('h1', { text: 'My claims' }), h('div', { class: 'toolbar' }, search, statusFilter, count), grid);
    apply();
  }

  // ------------------------------------------------------------------ claim detail
  async function claimView(id) {
    const draw = (c) => {
      const dl = (pairs) => h('dl', { class: 'facts' }, pairs.flatMap(([k, v, t]) => [h('dt', { text: k }), h('dd', { 'data-testid': t, text: v })]));
      const notice =
        c.status === 'APPROVED'
          ? h('p', { class: 'banner', role: 'status' }, 'Your claim has been approved. Check your email to confirm your settlement.')
          : c.status === 'REJECTED'
            ? h('p', { class: 'alert', role: 'alert' }, 'Your claim was not accepted.')
            : null;
      const canStatement = ['APPROVED', 'SETTLEMENT_ACCEPTED', 'SETTLED'].includes(c.status);
      return [
        h('h1', {}, `Claim ${c.claimId}`),
        notice,
        h(
          'section',
          { class: 'card', 'aria-label': 'Claim summary' },
          dl([
            ['Status', statusLabel(c.status), 'claim-status'],
            ['Policy', c.policyId, 'claim-policy'],
            ['Type', c.type, 'claim-type'],
            ['Incident date', c.incidentDate, 'claim-incident'],
            ['Amount claimed', money(c.amountClaimed), 'claim-amount'],
            ['Approved amount', money(c.approvedAmount), 'claim-approved'],
            ['Policy excess', money(c.deductible), 'claim-excess'],
            ['Settlement amount', money(c.payoutAmount), 'claim-payout'],
            ['Late notification', c.lateNotification ? 'Yes' : 'No', 'claim-late'],
          ]),
          canStatement ? h('p', {}, h('a', { href: `/bff/claims/${c.claimId}/statement.pdf`, download: `statement-${c.claimId}.pdf`, class: 'button' }, 'Download statement')) : null,
        ),
        h('section', { class: 'card', 'aria-label': 'Documents' }, h('h2', { text: 'Documents' }), c.documents.length ? h('ul', { 'aria-label': 'Claim documents' }, c.documents.map((d) => h('li', { text: `${d.filename} (${d.size} bytes)` }))) : h('p', { class: 'muted', text: 'No documents.' })),
        h('section', { class: 'card', 'aria-label': 'Timeline' }, h('h2', { text: 'Timeline' }), h('ol', { 'aria-label': 'Claim timeline' }, c.timeline.map((e) => h('li', { text: `${e.at.slice(0, 19).replace('T', ' ')} ${e.type}` })))),
      ];
    };
    let c = await api(`/bff/claims/${id}`);
    setView(`Claim ${id}`, ...draw(c));
    let status = c.status;
    pollTimer = setInterval(async () => {
      try {
        const n = await api(`/bff/claims/${id}`);
        if (n.status !== status || n.timeline.length !== c.timeline.length) {
          status = n.status;
          c = n;
          main.replaceChildren(...present(draw(n)));
        }
      } catch {
        /* transient; the next poll retries */
      }
    }, 1500);
  }

  // ------------------------------------------------------------------ settlement (from the e-mailed link)
  async function settlementView(id) {
    const token = new URLSearchParams(location.search).get('token') || '';
    const c = await api(`/bff/claims/${id}`);
    const err = errorBox();
    const code = h('input', { id: 'code', name: 'code', inputmode: 'numeric', autocomplete: 'off', maxlength: 6, required: true });
    const iban = h('input', { id: 'iban', name: 'iban', autocomplete: 'off', required: true, placeholder: 'GB00 BANK 0000 0000 0000 00' });
    const done = h('div', { id: 'settlement-done', role: 'status' });
    const form = h('form', { class: 'grid-form', 'aria-label': 'Settlement details' }, h('label', { for: 'code', text: 'Confirmation code' }), code, h('label', { for: 'iban', text: 'Bank account (IBAN)' }), iban, h('button', { type: 'submit', class: 'primary', text: 'Accept settlement' }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      try {
        const r = await api(`/bff/claims/${id}/settlement`, { method: 'POST', json: { token, code: code.value, iban: iban.value } });
        form.remove();
        done.textContent = `Settlement accepted. We will pay ${money(r.payoutAmount)} GBP to the account ending ${iban.value.replace(/\s+/g, '').slice(-4)} in the next payment run.`;
      } catch (ex) {
        showError(err, ex.message);
      }
    });
    setView(
      'Confirm your settlement',
      h('h1', { text: 'Confirm your settlement' }),
      h('p', {}, `Claim ${id}: we will pay `, h('strong', { 'data-testid': 'settlement-amount', text: `${money(c.payoutAmount)} GBP` }), '.'),
      c.status === 'APPROVED' ? null : h('p', { class: 'alert', role: 'alert', text: `This claim is ${statusLabel(c.status).toLowerCase()}.` }),
      err,
      h('section', { class: 'card' }, form, done),
    );
  }

  render();
})();
