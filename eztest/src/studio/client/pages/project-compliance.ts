/** Project › Compliance: signed evidence packs (generic / CSA-Part 11 / SOX), offline verification and the traceability table. */
import { api } from '../core/api.js';
import { clear, h, uid } from '../core/dom.js';
import { dateTime, plural } from '../core/format.js';
import { button, card, emptyState } from '../ui/badge.js';
import { confirmDialog } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { dataTable, field, filePicker, fmtBytes, pageHeader, readAsBase64, sevBadge, withStates, type SubPageDef } from './assurance-ui.js';

interface Profile {
  id: string;
  title: string;
  requireTraceability: boolean;
  requirementLabel: string;
  signatureMeaning: string;
  statements: string[];
}

interface ComplianceView {
  key: { exists: boolean; fingerprint?: string; createdAt?: string };
  profiles: Profile[];
  runs: Array<{ runId: string; startedAt?: string; summary?: { total: number; passed: number; failed: number } }>;
  packs: Array<{ path: string; size: number; mtime: string; runId?: string }>;
}

interface ManifestView {
  createdAt: string;
  signer: { name: string; role: string; meaning: string };
  key: { fingerprint: string };
  profile: { id: string; title: string; warnings: string[]; requirementLabel: string };
  run: { runId: string; startedAt: string; summary: { total: number; passed: number; failed: number } };
  evidence: { head: string; entries: number; included: number; excluded: number };
  files: number;
  traceability: Array<{ requirement: string; journeyId: string; journeyName: string; status: string; evidence: string[] }>;
  untracedJourneys: Array<{ journeyId: string; name: string; status: string }>;
}

function traceTable(m: ManifestView, id: string): HTMLElement {
  return h('div', { class: 'stack-sm', id },
    h('h3', { class: 'h3', text: 'Traceability' }),
    dataTable({
      caption: 'Traceability: requirements to journeys and evidence',
      rows: m.traceability,
      empty: 'No journey lists a requirement.',
      columns: [
        { title: m.profile.requirementLabel, render: (r) => h('strong', { text: r.requirement }) },
        { title: 'Journey', render: (r) => r.journeyName },
        { title: 'Result', render: (r) => sevBadge(r.status === 'passed' || r.status === 'passed-healed' ? 'pass' : 'fail', r.status) },
        { title: 'Evidence', render: (r) => h('span', { class: 'small', text: r.evidence.join(', ') }) },
      ],
    }),
    m.untracedJourneys.length ? h('p', { class: 'warn-text small', text: `Not traced to a ${m.profile.requirementLabel.toLowerCase()}: ${m.untracedJourneys.map((u) => u.name).join(', ')}` }) : h('span'));
}

function manifestSummary(m: ManifestView): HTMLElement {
  return h('dl', { class: 'kv' },
    h('dt', { text: 'Profile' }), h('dd', { text: m.profile.title }),
    h('dt', { text: 'Signer' }), h('dd', { text: `${m.signer.name}, ${m.signer.role} — "${m.signer.meaning}"` }),
    h('dt', { text: 'Signed' }), h('dd', { text: dateTime(m.createdAt) }),
    h('dt', { text: 'Key' }), h('dd', null, h('code', { text: m.key.fingerprint })),
    h('dt', { text: 'Run' }), h('dd', { text: `${m.run.runId} · ${m.run.summary.passed}/${m.run.summary.total} passed` }),
    h('dt', { text: 'Evidence' }), h('dd', null, `${m.evidence.included}/${m.evidence.entries} entries, ${m.files} files · chain head `, h('code', { text: m.evidence.head.slice(0, 16) })),
  );
}

export const complianceSection: SubPageDef = {
  id: 'compliance',
  title: 'Compliance',
  icon: 'certificate',
  description: 'Signed evidence packs, verification',
  mount(root) {
    const body = h('div', { class: 'stack' });
    root.appendChild(h('div', { class: 'page-inner' }, pageHeader('Compliance', 'Signed, tamper-evident evidence packs per run for auditors (generic, CSA / 21 CFR Part 11, SOX), offline verification and requirement traceability.'), body));
    const load = async () => {
      const v = await withStates(body, () => api.get<ComplianceView>('/api/project/compliance'), { retry: () => void load() });
      if (!v) return;
      // ------------------------------------------------ key
      const keyCard = card('Signing key', v.key.exists
        ? h('div', { class: 'stack-sm' }, h('p', null, sevBadge('ok', 'ed25519 key ready'), ' ', h('code', { id: 'key-fp', text: v.key.fingerprint ?? '' })), h('p', { class: 'small muted', text: 'The private key stays in .eztest/keys (mode 0600) and is never served. Share the public key with auditors.' }), h('a', { class: 'btn btn-sm', href: '/api/project/compliance/download?what=public-key', download: 'eztest-studio-signing.pub.pem' }, 'Download public key'))
        : h('div', { class: 'stack-sm' }, h('p', { class: 'muted', text: 'No signing key yet. Generate one for this project (ed25519); the private key never leaves .eztest/keys.' }), button('Generate signing key', { kind: 'primary', icon: 'key', id: 'gen-key', onclick: async () => {
            if (!(await confirmDialog({ title: 'Generate a signing key?', message: 'Create an ed25519 key pair in .eztest/keys for signing evidence packs from this Studio.', confirm: 'Generate' }))) return;
            try {
              await api.post('/api/project/compliance/key', {});
              toast('Signing key generated', { kind: 'success' });
              await load();
            } catch (e) {
              toastError((e as Error).message);
            }
          } })), { id: 'key' });
      // ------------------------------------------------ generate
      const runSel = h('select', { class: 'input', id: uid('pack-run') }, v.runs.map((r) => h('option', { value: r.runId, text: `${r.startedAt ? dateTime(r.startedAt) : ''} · ${r.runId}${r.summary ? ` · ${r.summary.passed}/${r.summary.total} passed` : ''}` })));
      const profSel = h('select', { class: 'input', id: uid('profile') }, v.profiles.map((p) => h('option', { value: p.id, text: p.title })));
      const profInfo = h('div', { class: 'small' });
      const showProfile = () => {
        const p = v.profiles.find((x) => x.id === profSel.value);
        clear(profInfo);
        if (p) profInfo.append(h('p', { class: 'muted', text: `Signature meaning: "${p.signatureMeaning}"${p.requireTraceability ? ` · every journey should trace to a ${p.requirementLabel.toLowerCase()}` : ''}` }), h('ul', { class: 'bullets' }, p.statements.map((s) => h('li', { text: s }))));
      };
      profSel.addEventListener('change', showProfile);
      showProfile();
      const signer = h('input', { class: 'input', id: 'signer-name', autocomplete: 'name' });
      const role = h('input', { class: 'input', id: 'signer-role', value: 'QA Lead' });
      const meaning = h('input', { class: 'input', id: 'signer-meaning', placeholder: 'Default: the profile\'s meaning' });
      const genOut = h('div', { 'aria-live': 'polite', id: 'pack-result' });
      const generate = async () => {
        if (!signer.value.trim()) {
          toastError('Enter the signer\'s name');
          return;
        }
        if (!(await confirmDialog({ title: 'Sign and generate the pack?', message: `Sign the evidence of ${runSel.value} as ${signer.value} (${role.value}) with the ${profSel.selectedOptions[0]?.text} profile. The pack is written into the run folder.`, confirm: 'Sign and generate' }))) return;
        const r = await withStates(genOut, () => api.post<{ path: string; sha256: string; bytes: number; manifest: ManifestView; summary: string }>('/api/project/compliance/pack', { runId: runSel.value, profile: profSel.value, signer: { name: signer.value, role: role.value, meaning: meaning.value } }), { loading: 'Verifying the evidence chain and signing…' });
        if (!r) return;
        genOut.append(
          h('p', { class: 'row wrap' }, sevBadge('ok', 'Pack signed'), h('code', { text: r.path }), h('span', { class: 'muted', text: `${fmtBytes(r.bytes)} · sha256 ${r.sha256.slice(0, 16)}…` })),
          h('p', { class: 'row wrap' }, h('a', { class: 'btn btn-sm', href: `/api/project/compliance/download?path=${encodeURIComponent(r.path)}`, download: r.path.split('/').pop() }, 'Download pack'), h('a', { class: 'btn btn-sm', href: r.summary, target: '_blank', rel: 'noopener' }, 'Auditor summary')),
          r.manifest.profile.warnings.length ? h('ul', { class: 'bullets warn-text' }, r.manifest.profile.warnings.map((w) => h('li', { text: w }))) : h('span'),
          manifestSummary(r.manifest),
          traceTable(r.manifest, 'pack-trace'),
        );
        void refreshPacks();
      };
      const genCard = card('Generate an evidence pack', v.runs.length
        ? h('form', { class: 'stack', onsubmit: (e: Event) => (e.preventDefault(), void generate()) },
            h('div', { class: 'form-grid' }, field('Run', runSel), field('Profile', profSel), field('Signer name', signer), field('Signer role', role), field('Meaning of the signature', meaning)),
            profInfo,
            h('div', null, h('button', { type: 'submit', class: 'btn btn-primary', disabled: !v.key.exists, text: 'Sign and generate pack' }), v.key.exists ? h('span') : h('span', { class: 'small muted', text: ' Generate the signing key first.' })),
            genOut)
        : emptyState('No runs', 'Run journeys first; a pack attests one run\'s evidence.'), { id: 'generate' });
      // ------------------------------------------------ verify
      const packSel = h('select', { class: 'input', id: uid('pack') });
      const refreshPacks = async () => {
        const fresh = await api.get<ComplianceView>('/api/project/compliance').catch(() => v);
        clear(packSel).append(h('option', { value: '', text: fresh.packs.length ? 'Choose a pack…' : 'No packs in the project' }), ...fresh.packs.map((p) => h('option', { value: p.path, text: `${p.path} (${fmtBytes(p.size)})` })));
        if (fresh.packs[0]) packSel.value = fresh.packs[0].path;
      };
      void refreshPacks();
      let uploaded: { name: string; data: string } | undefined;
      const upStatus = h('span', { class: 'small muted', 'aria-live': 'polite' });
      const up = filePicker({ label: 'Upload a pack (.zip)', accept: '.zip,application/zip', onFile: async (f) => {
        uploaded = { name: f.name, data: await readAsBase64(f) };
        upStatus.textContent = `${f.name} ready (verifying it uses the upload instead of the list)`;
      } });
      const pub = h('textarea', { class: 'input mono-input', rows: 3, placeholder: '-----BEGIN PUBLIC KEY----- … (empty: the Studio key)' });
      const verOut = h('div', { 'aria-live': 'polite', id: 'verify-result' });
      const verify = async () => {
        const body = uploaded ? { data: uploaded.data, publicKeyPem: pub.value || undefined } : { path: packSel.value, publicKeyPem: pub.value || undefined };
        if (!uploaded && !packSel.value) {
          toastError('Choose or upload a pack');
          return;
        }
        const r = await withStates(verOut, () => api.post<{ ok: boolean; signatureValid: boolean; filesChecked: number; problems: string[]; manifest?: ManifestView }>('/api/project/compliance/verify', body), { loading: 'Verifying signature, hashes and the evidence chain…' });
        if (!r) return;
        verOut.append(
          h('p', { class: 'row wrap' }, sevBadge(r.ok ? 'pass' : 'fail', r.ok ? 'VALID' : 'INVALID'), h('span', { class: 'muted', text: `signature ${r.signatureValid ? 'valid' : 'NOT valid'} · ${plural(r.filesChecked, 'file')} checked` })),
          r.problems.length ? h('ul', { class: 'bullets bad-text' }, r.problems.map((p) => h('li', { text: p }))) : h('span'),
          r.manifest ? manifestSummary(r.manifest) : h('span'),
          r.manifest ? traceTable(r.manifest, 'verify-trace') : h('span'),
        );
      };
      const verCard = card('Verify a pack', h('form', { class: 'stack', onsubmit: (e: Event) => (e.preventDefault(), void verify()) },
        h('div', { class: 'form-grid' }, field('Pack in the project', packSel), h('div', { class: 'row wrap' }, up, upStatus)),
        field('Signer\'s public key (PEM)', pub),
        h('div', null, h('button', { type: 'submit', class: 'btn btn-primary', text: 'Verify pack' })),
        verOut), { id: 'verify' });
      body.append(keyCard, genCard, verCard);
    };
    return { show: () => void load() };
  },
};

