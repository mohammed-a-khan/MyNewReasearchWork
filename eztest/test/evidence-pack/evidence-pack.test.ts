import { describe, it, expect, beforeAll } from '../support/testkit.js';
import { mkdtemp, writeFile, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceVault, summarize, type JourneyResult, type RunResult } from '../../src/core/index.js';
import { runJourneys } from '../../src/runner/index.js';
import {
  generateSigningKey,
  createEvidencePack,
  verifyEvidencePack,
  renderPackSummary,
  readZip,
  writeZip,
  crc32,
  PACK_MANIFEST,
  type PackManifest,
} from '../../src/evidence-pack/index.js';

const keys = generateSigningKey();
const signer = { name: 'Dana Auditor', role: 'QA Lead' };

/** A realistic run directory built with the real EvidenceVault. */
async function buildRunDir(opts: { journeyName?: string; extraEvidence?: string } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eztest-pack-run-'));
  const vault = new EvidenceVault(dir);
  await vault.init();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 200 }, (_, i) => i % 256)]);
  const shot = await vault.store('screenshot', 'checkout/s1.png', png, { journeyId: 'checkout', stepId: 's1' });
  const dom = await vault.store('dom', 'checkout/s1.html', '<html><body><h1>Order placed</h1></body></html>', { journeyId: 'checkout', stepId: 's1' });
  const net = await vault.store('network', 'checkout/network.json', JSON.stringify([{ method: 'GET', url: '/api/orders', status: 200 }]), { journeyId: 'checkout' });
  const login = await vault.store('screenshot', 'login/s1.png', png, { journeyId: 'login', stepId: 's1' });
  if (opts.extraEvidence) await vault.store('log', 'checkout/console.log', opts.extraEvidence, { journeyId: 'checkout' });
  const journeys: JourneyResult[] = [
    {
      journeyId: 'checkout', name: opts.journeyName ?? 'Checkout', status: 'passed', startedAt: '', durationMs: 1200, steps: [], tags: [],
      requirements: ['REQ-12', 'REQ-7'], risk: 4, attempt: 1, ledger: {}, evidence: [shot.id, dom.id, net.id],
    },
    {
      journeyId: 'login', name: 'Login', status: 'failed', startedAt: '', durationMs: 800, steps: [], tags: [],
      requirements: [], risk: 3, attempt: 1, ledger: {}, evidence: [login.id],
    },
  ];
  const run: RunResult = {
    runId: 'run-20261022', startedAt: '2026-10-22T10:00:00.000Z', finishedAt: '2026-10-22T10:00:05.000Z', durationMs: 5000,
    journeys, summary: summarize(journeys), environment: { node: process.version, baseUrl: 'https://app.example' }, evidenceHead: vault.headHash,
  };
  await writeFile(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  await writeFile(join(dir, 'report.html'), '<html><body>EZTest report</body></html>');
  await writeFile(join(dir, 'junit.xml'), '<testsuites/>');
  return dir;
}

/** Rewrite a pack with a transformation applied to its entries (CRC kept valid, like a careful attacker). */
async function rezip(file: string, out: string, fn: (entries: Array<{ name: string; data: Buffer }>) => Array<{ name: string; data: Buffer }>) {
  const entries = readZip(await readFile(file)).map((e) => ({ name: e.name, data: e.data }));
  await writeFile(out, writeZip(fn(entries)));
}

describe('evidence-pack: zip', () => {
  it('round-trips stored and deflated entries and checks CRCs', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const big = Buffer.from('a'.repeat(5000));
    const tiny = Buffer.from([1]);
    const zip = writeZip([{ name: 'dir/big.txt', data: big }, { name: 'ü.bin', data: tiny }]);
    const back = readZip(zip);
    expect(back.map((e) => [e.name, e.method, e.data.length])).toEqual([['dir/big.txt', 8, 5000], ['ü.bin', 0, 1]]);
    expect(() => writeZip([{ name: '../evil', data: tiny }])).toThrow(/Unsafe/);
    const flipped = Buffer.from(zip);
    flipped[40] ^= 0xff; // inside the first entry's compressed data
    expect(() => readZip(flipped)).toThrow(/Invalid ZIP/);
  });
});

describe('evidence-pack: create and verify', () => {
  let runDir: string;
  let pack: string;
  let manifest: PackManifest;
  let work: string;

  beforeAll(async () => {
    runDir = await buildRunDir({ journeyName: 'Checkout <script>alert(1)</script>' });
    work = await mkdtemp(join(tmpdir(), 'eztest-pack-'));
    pack = join(work, 'pack.zip');
    const r = await createEvidencePack(runDir, pack, { privateKeyPem: keys.privateKeyPem, signer, regulatoryProfile: 'csa-part11', now: new Date('2026-10-22T12:00:00Z') });
    manifest = r.manifest;
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('packs run.json, the chain, evidence and reports with a traceability table', async () => {
    const names = readZip(await readFile(pack)).map((e) => e.name).sort();
    expect(names).toEqual(
      [
        'checkout/network.json', 'checkout/s1.html', 'checkout/s1.png', 'evidence-manifest.jsonl', 'junit.xml', 'login/s1.png',
        'pack-manifest.json', 'pack-manifest.sig', 'report.html', 'run.json',
      ].sort(),
    );
    expect(manifest.signer).toMatchObject({ name: 'Dana Auditor', role: 'QA Lead' });
    expect(manifest.signer.meaning).toMatch(/assurance activity/);
    expect(manifest.profile.id).toBe('csa-part11');
    expect(manifest.evidence.entries).toBe(4);
    expect(manifest.traceability.map((t) => [t.requirement, t.journeyId, t.status])).toEqual([
      ['REQ-12', 'checkout', 'passed'],
      ['REQ-7', 'checkout', 'passed'],
    ]);
    expect(manifest.untracedJourneys.map((u) => u.journeyId)).toEqual(['login']);
    expect(manifest.profile.warnings.join(' ')).toMatch(/1 journey\(s\) have no requirement/);
    expect(manifest.files.find((f) => f.path === 'report.html')?.role).toBe('report');
  });

  it('verifies a genuine pack', async () => {
    const v = await verifyEvidencePack(pack, keys.publicKeyPem);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.signatureValid).toBe(true);
    expect(v.filesChecked).toBe(8);
    expect(v.evidence).toMatchObject({ ok: true, entries: 4, head: manifest.evidence.head });
  });

  it('detects a modified evidence file inside the zip', async () => {
    const out = join(work, 't1.zip');
    await rezip(pack, out, (es) => es.map((e) => (e.name === 'checkout/s1.html' ? { ...e, data: Buffer.from('<html>forged</html>') } : e)));
    const v = await verifyEvidencePack(out, keys.publicKeyPem);
    expect(v.ok).toBe(false);
    expect(v.signatureValid).toBe(true);
    expect(v.problems).toContain('file content altered: checkout/s1.html (sha256 mismatch)');
    expect(v.problems.some((p) => p.startsWith('evidence chain:') && p.includes('file content altered checkout/s1.html'))).toBe(true);
  });

  it('detects an edited manifest (signature invalid)', async () => {
    const out = join(work, 't2.zip');
    await rezip(pack, out, (es) =>
      es.map((e) => {
        if (e.name !== PACK_MANIFEST) return e;
        const m = JSON.parse(e.data.toString('utf8')) as PackManifest;
        m.run.summary.failed = 0;
        m.run.summary.passed = 2;
        return { ...e, data: Buffer.from(JSON.stringify(m)) };
      }),
    );
    const v = await verifyEvidencePack(out, keys.publicKeyPem);
    expect(v.ok).toBe(false);
    expect(v.signatureValid).toBe(false);
    expect(v.problems).toContain('signature invalid: the manifest was altered after signing');
  });

  it('detects a wrong public key', async () => {
    const other = generateSigningKey();
    const v = await verifyEvidencePack(pack, other.publicKeyPem);
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toMatch(/signature invalid: .*wrong key/);
  });

  it('detects added, removed and raw-corrupted files', async () => {
    const added = join(work, 't3.zip');
    await rezip(pack, added, (es) => [...es, { name: 'checkout/injected.png', data: Buffer.from('x') }]);
    expect((await verifyEvidencePack(added, keys.publicKeyPem)).problems).toContain('unlisted file in pack: checkout/injected.png');

    const removed = join(work, 't4.zip');
    await rezip(pack, removed, (es) => es.filter((e) => e.name !== 'login/s1.png'));
    const r = await verifyEvidencePack(removed, keys.publicKeyPem);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('file missing from pack: login/s1.png');

    const raw = Buffer.from(await readFile(pack));
    const idx = raw.indexOf(Buffer.from('junit.xml')); // first occurrence: local header name
    raw[idx + 'junit.xml'.length + 2] ^= 0x55;
    const corrupt = join(work, 't5.zip');
    await writeFile(corrupt, raw);
    const c = await verifyEvidencePack(corrupt, keys.publicKeyPem);
    expect(c.ok).toBe(false);
    expect(c.problems[0]).toMatch(/cannot read pack|altered/);
  });

  it('renders an escaped auditor summary in HTML and Markdown', () => {
    const html = renderPackSummary(manifest);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('REQ-12');
    expect(html).toContain('What the signature proves');
    expect(html).toMatch(/does not prove/);
    const md = renderPackSummary(manifest, { format: 'markdown' });
    expect(md).toContain('| REQ-12 |');
    expect(md).toContain('\\<script\\>');
    expect(md).toContain('## What the signature proves');
  });
});

describe('evidence-pack: refusals and options', () => {
  it('refuses a run whose evidence chain is broken', async () => {
    const dir = await buildRunDir();
    await appendFile(join(dir, 'checkout/s1.html'), '<!-- edited -->');
    await expect(
      createEvidencePack(dir, join(dir, '..', 'x.zip'), { privateKeyPem: keys.privateKeyPem, signer }),
    ).rejects.toThrow(/chain is broken[\s\S]*file content altered checkout\/s1.html/);
  });

  it('refuses missing signer, non-ed25519 keys and files that contain live credentials', async () => {
    const dir = await buildRunDir({ extraEvidence: 'request failed; "authorization": "Bearer abcdef0123456789abcdef"' });
    const out = join(dir, '..', `s-${Date.now()}.zip`);
    await expect(createEvidencePack(dir, out, { privateKeyPem: keys.privateKeyPem, signer: { name: '', role: 'x' } })).rejects.toThrow(/signer/);
    const { generateKeyPairSync } = await import('node:crypto');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await expect(createEvidencePack(dir, out, { privateKeyPem: rsa.privateKey, signer })).rejects.toThrow(/ed25519/);
    await expect(createEvidencePack(dir, out, { privateKeyPem: keys.privateKeyPem, signer })).rejects.toThrow(/live credential/);
    const warned = await createEvidencePack(dir, out, { privateKeyPem: keys.privateKeyPem, signer, secretPolicy: 'warn' });
    expect(warned.manifest.profile.warnings.some((w) => w.includes('checkout/console.log'))).toBe(true);
    await expect(createEvidencePack(dir, out, { privateKeyPem: keys.privateKeyPem, signer, regulatoryProfile: 'hipaa' as never })).rejects.toThrow(/Not supported/);
  });

  it('kind filter excludes files but keeps them verifiable; extra files and SOX profile', async () => {
    const dir = await buildRunDir();
    const spec = join(dir, '..', `spec-${Date.now()}.md`);
    await writeFile(spec, '# Approved spec v3');
    const out = join(dir, '..', `f-${Date.now()}.zip`);
    const r = await createEvidencePack(dir, out, {
      privateKeyPem: keys.privateKeyPem, signer, include: ['screenshot'], extraFiles: [{ path: spec, as: 'spec.md' }], regulatoryProfile: 'sox',
    });
    expect(r.manifest.evidence.excluded.map((x) => x.path).sort()).toEqual(['checkout/network.json', 'checkout/s1.html']);
    expect(r.manifest.files.some((f) => f.path === 'extra/spec.md' && f.role === 'extra')).toBe(true);
    expect(r.manifest.profile.requirementLabel).toBe('Control id');
    const v = await verifyEvidencePack(out, keys.publicKeyPem);
    expect(v.problems).toEqual([]);
    expect(v.evidence?.excluded).toBe(2);
  });
});

describe('evidence-pack: a real EZTest run', () => {
  it('packs and verifies the output of runJourneys', async () => {
    const out = await mkdtemp(join(tmpdir(), 'eztest-pack-real-'));
    const run = await runJourneys(
      [
        {
          id: 'hello', name: 'Hello page', tags: [], data: [], variables: {}, requirements: ['REQ-1'], risk: 2, lenses: [],
          steps: [
            { id: 'open', intent: 'Open hello page', action: 'navigate', value: 'data:text/html,<title>Hello</title><h1>Hello EZTest</h1>', postconditions: [{ type: 'pageContainsText', value: 'Hello EZTest' }], optional: false },
          ],
        },
      ],
      { stepTimeoutMs: 5000, locateTimeoutMs: 1500, conditionTimeoutMs: 3000, outputDir: out, screenshots: 'every-step' },
    );
    expect(run.journeys[0].status).toBe('passed');
    const runDir = join(out, run.runId);
    const packFile = join(out, 'evidence.zip');
    const r = await createEvidencePack(runDir, packFile, { privateKeyPem: keys.privateKeyPem, signer });
    expect(r.manifest.evidence.head).toBe(run.evidenceHead);
    expect(r.manifest.traceability).toEqual([{ requirement: 'REQ-1', journeyId: 'hello', journeyName: 'Hello page', status: 'passed', evidence: run.journeys[0].evidence }]);
    const v = await verifyEvidencePack(packFile, keys.publicKeyPem);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
  });
});
