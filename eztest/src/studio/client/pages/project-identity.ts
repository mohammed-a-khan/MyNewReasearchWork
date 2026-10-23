/**
 * Project › Identities and roles: roles with secret references (never
 * values), headless test login with a screenshot, the TOTP code on explicit
 * request (auto-hidden when it expires), session cache status and clearing,
 * and ENC() encryption with the server's EZTEST_MASTER_KEY.
 */
import { api } from '../core/api.js';
import { clear, h, uid } from '../core/dom.js';
import { ms, relTime } from '../core/format.js';
import { button, card, copyText, emptyState } from '../ui/badge.js';
import { confirmDialog } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { field, kvList, loadingState, pageHeader, sevBadge, withStates, type SubPageDef } from './assurance-ui.js';

interface SecretDesc {
  kind: string;
  ref?: string;
  value?: string;
  source?: string;
}

interface Role {
  name: string;
  username: SecretDesc;
  password: SecretDesc;
  totp?: SecretDesc;
  loginUrl: string;
  successUrl?: string;
  api?: { tokenUrl: string; clientId: string; clientSecret: SecretDesc; scope?: string };
  session: { cached: boolean; fresh?: boolean; ageMs?: number; savedAt?: string; file?: string; maxAgeMinutes?: number };
}

interface IdentityView {
  environment: string;
  baseUrl?: string;
  sessionDir: string;
  stores: Array<{ type: string; name: string; prefix?: string; path?: string; implicit?: boolean }>;
  masterKey: boolean;
  roles: Role[];
}

function secret(d: SecretDesc | undefined): HTMLElement {
  if (!d || d.kind === 'none') return h('span', { class: 'muted', text: '—' });
  if (d.kind === 'plain' && d.value !== undefined) return h('span', { text: d.value });
  const label = d.kind === 'secret-ref' ? 'secret reference' : d.kind === 'encrypted' ? 'encrypted in config' : d.kind === 'env-var' ? 'environment variable' : 'plain text';
  return h('span', null, h('code', { class: 'secret-ref', text: d.ref ?? '' }), ' ', sevBadge(d.kind === 'plain' ? 'warn' : 'ok', label));
}

function roleCard(r: Role, reload: () => void): HTMLElement {
  const result = h('div', { class: 'stack-sm', 'aria-live': 'polite', dataset: { role: r.name } });
  const totpHost = h('div', { 'aria-live': 'polite' });
  let totpTimer: ReturnType<typeof setInterval> | undefined;
  const hideTotp = () => {
    clearInterval(totpTimer);
    clear(totpHost);
  };
  const testLogin = async () => {
    clear(result).appendChild(loadingState(`Signing in as ${r.name} in a headless browser…`));
    try {
      const x = await api.post<{ ok: boolean; error?: string; url: string; durationMs: number; screenshot?: string; reused: boolean }>(`/api/project/identity/roles/${encodeURIComponent(r.name)}/test-login`, {});
      clear(result).append(
        h('p', { class: 'row wrap', dataset: { testid: 'login-result' } }, sevBadge(x.ok ? 'pass' : 'fail', x.ok ? 'Login passed' : 'Login failed'), h('span', { class: 'muted', text: `${ms(x.durationMs)} · ended at ${x.url}` })),
        x.error ? h('p', { class: 'bad-text', text: x.error }) : h('span'),
        x.screenshot ? h('img', { src: x.screenshot, alt: `Browser after the ${r.name} login`, class: 'login-shot' }) : h('span'),
      );
    } catch (e) {
      clear(result).appendChild(h('p', { class: 'bad-text', role: 'alert', text: (e as Error).message }));
    }
  };
  const showTotp = async () => {
    hideTotp();
    try {
      const x = await api.post<{ code: string; secondsRemaining: number }>(`/api/project/identity/roles/${encodeURIComponent(r.name)}/totp`, {});
      let left = x.secondsRemaining;
      const count = h('span', { class: 'countdown muted' });
      const tick = () => {
        count.textContent = `hides in ${left}s`;
        if (left-- <= 0) hideTotp();
      };
      totpHost.append(h('p', { class: 'row wrap' }, h('span', { class: 'totp-code', 'aria-hidden': 'true', text: x.code }), h('span', { class: 'sr-only', text: `Current code ${x.code.split('').join(' ')}` }), count, button('Hide', { small: true, kind: 'ghost', onclick: hideTotp })));
      tick();
      totpTimer = setInterval(tick, 1000);
    } catch (e) {
      toastError((e as Error).message);
    }
  };
  const clearSession = async () => {
    if (!(await confirmDialog({ title: 'Clear the cached session?', message: `The next run signs in as ${r.name} through the UI again.`, confirm: 'Clear session', danger: true }))) return;
    try {
      await api.del(`/api/project/identity/roles/${encodeURIComponent(r.name)}/session`);
      toast(`Session of ${r.name} cleared`, { kind: 'success' });
      reload();
    } catch (e) {
      toastError((e as Error).message);
    }
  };
  const s = r.session;
  return card(r.name, h('div', { class: 'stack' },
    kvList([
      ['Username', secret(r.username)],
      ['Password', secret(r.password)],
      ['TOTP', r.totp ? secret(r.totp) : h('span', { class: 'muted', text: 'none' })],
      ['Login page', h('code', { text: r.loginUrl })],
      ['Success', h('code', { text: r.successUrl ?? '(not checked)' })],
      ['API', r.api ? h('span', null, h('code', { text: `${r.api.clientId} @ ${r.api.tokenUrl}` }), ' ', secret(r.api.clientSecret)) : h('span', { class: 'muted', text: 'no API credentials' })],
      ['Session cache', s.cached ? h('span', null, sevBadge(s.fresh ? 'ok' : 'warn', s.fresh ? 'fresh' : 'expired'), h('span', { class: 'muted', text: ` saved ${relTime(s.savedAt)} (max ${s.maxAgeMinutes} min)` })) : h('span', { class: 'muted', text: 'none' })],
    ]),
    h('div', { class: 'row wrap' },
      button('Test login', { kind: 'primary', icon: 'run', onclick: () => void testLogin(), ariaLabel: `Test login for ${r.name}` }),
      r.totp ? button('Show TOTP code', { icon: 'key', onclick: () => void showTotp(), ariaLabel: `Show TOTP code for ${r.name}` }) : null,
      button('Clear session', { icon: 'trash', kind: 'danger', disabled: !s.cached, onclick: () => void clearSession(), ariaLabel: `Clear session for ${r.name}` })),
    totpHost,
    result,
  ), { id: `role-${r.name}` });
}

function encryptCard(masterKey: boolean): HTMLElement {
  const id = uid('enc');
  const input = h('input', { type: 'password', class: 'input', id, autocomplete: 'off', disabled: !masterKey });
  const out = h('div', { 'aria-live': 'polite' });
  const run = async () => {
    try {
      const r = await api.post<{ text: string }>('/api/project/identity/encrypt', { value: input.value });
      input.value = '';
      const copy = button('Copy', { small: true, icon: 'copy' });
      copy.addEventListener('click', () => void copyText(r.text, copy));
      clear(out).append(h('p', { class: 'help', text: 'Paste this into eztest.config.yaml (e.g. password: ENC(…)). Only a process with the same EZTEST_MASTER_KEY can read it.' }), h('pre', { class: 'code-block', id: 'enc-output', text: r.text }), copy);
    } catch (e) {
      clear(out).appendChild(h('p', { class: 'bad-text', role: 'alert', text: (e as Error).message }));
    }
  };
  return card('Encrypt a value', h('form', { class: 'stack', onsubmit: (e: Event) => (e.preventDefault(), void run()) },
    masterKey ? h('p', { class: 'muted', text: 'Encrypted on the server with EZTEST_MASTER_KEY (AES-256-GCM, scrypt). The plain value is not stored or logged.' }) : h('p', { class: 'note note-warn', role: 'status', id: 'enc-nokey', text: 'EZTEST_MASTER_KEY is not set for the Studio process, so values cannot be encrypted. Set it (16+ characters) in the environment that starts "eztest studio".' }),
    field('Value to encrypt', input),
    h('div', null, h('button', { type: 'submit', class: 'btn btn-primary', disabled: !masterKey, text: 'Encrypt' })),
    out), { id: 'encrypt' });
}

export const identitySection: SubPageDef = {
  id: 'identity',
  title: 'Identities & roles',
  icon: 'key',
  description: 'Roles, test login, TOTP, sessions, ENC()',
  mount(root) {
    const body = h('div', { class: 'stack' });
    root.appendChild(h('div', { class: 'page-inner' }, pageHeader('Identities & roles', 'Roles from the Identity Vault with their secret references. Values never reach the browser: logins and codes are produced on the server.'), body));
    const load = async () => {
      const v = await withStates(body, () => api.get<IdentityView>('/api/project/identity'), { retry: () => void load() });
      if (!v) return;
      body.append(
        h('p', { class: 'muted', text: `Environment ${v.environment} · base URL ${v.baseUrl ?? '(none)'} · sessions in ${v.sessionDir} · secret stores: ${v.stores.map((s) => `${s.name}${s.prefix ? ` (prefix ${s.prefix})` : ''}`).join(', ')}` }),
        v.roles.length ? h('div', { class: 'cards' }, v.roles.map((r) => roleCard(r, () => void load()))) : emptyState('No roles', 'Define identity.roles in eztest.config.yaml (username, password as secret://…, loginUrl).'),
        encryptCard(v.masterKey),
      );
    };
    return { show: () => void load() };
  },
};
