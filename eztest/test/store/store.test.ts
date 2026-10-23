/**
 * Shared test data: the grammar (and its round trip), the file backend
 * (cross-run handoff, TTL expiry, locking), data pools claimed by parallel
 * processes without duplicates, release on failure, secrets sealed at rest and
 * masked, and the pipeline outputs (Azure Pipelines logging commands,
 * $GITHUB_OUTPUT, store-export.json and EZTEST_STORE_IMPORT in a later stage).
 */
import { describe, expect, it } from '../support/testkit.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEzScript, journeyToEzScript, parseIntent, loadJourneyFile } from '../../src/intent/index.js';
import {
  FileStoreBackend, SharedStore, StoreCipher, formatOutputs, githubOutputLine, variableName, vsoSetVariable, parseTtl, storeStepToText,
} from '../../src/store/index.js';
import { SecretMasker } from '../../src/config/masker.js';
import type { Step } from '../../src/core/index.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tmp = (p: string) => mkdtemp(join(tmpdir(), `ez-store-${p}-`));
const KEY = 'store-key-for-tests-0123456789abcdef';

describe('shared store grammar', () => {
  const cases: Array<[string, Record<string, unknown>, string?]> = [
    ['Save ${orderId} to the shared store as "pending-order"', { op: 'save', key: 'pending-order', value: '${orderId}' }],
    ['Save ${orderId} to the shared store as "pending-order" for 2 days in namespace "sit"', { op: 'save', key: 'pending-order', value: '${orderId}', namespace: 'sit', ttlMs: 2 * 86_400_000 }],
    ['Save ${token} to the shared store as "api-token" as a secret for the pipeline', { op: 'save', key: 'api-token', value: '${token}', pipeline: true, secret: true }],
    ['Load "pending-order" from the shared store as orderId', { op: 'load', key: 'pending-order' }, 'orderId'],
    ['Load "pending-order" from the shared store as orderId or use "ORD-0"', { op: 'load', key: 'pending-order', default: 'ORD-0' }, 'orderId'],
    ['Delete "pending-order" from the shared store', { op: 'delete', key: 'pending-order' }],
    ['Add ${policy} to pool "approvable-policies"', { op: 'poolAdd', pool: 'approvable-policies', value: '${policy}' }],
    ['Take one item from pool "approvable-policies" as policy', { op: 'poolTake', pool: 'approvable-policies' }, 'policy'],
    ['Take one item from pool "approvable-policies" as policy and keep it', { op: 'poolTake', pool: 'approvable-policies', keep: true }, 'policy'],
    ['Expect pool "approvable-policies" has at least 3 items', { op: 'poolCount', pool: 'approvable-policies', min: 3 }],
    ['Fill pool "approvable-policies" from "data/policies.csv" column "policyNo"', { op: 'poolSeed', pool: 'approvable-policies', file: 'data/policies.csv', column: 'policyNo' }],
  ];
  for (const [line, args, as] of cases) {
    it(`parses and renders: ${line}`, () => {
      const s = parseIntent(line);
      expect(s.action).toBe('store');
      expect(s.args).toEqual(args);
      if (as) expect(s.captureAs).toBe(as);
      const again = parseIntent(storeStepToText(s as Step));
      expect(again.args).toEqual(args);
    });
  }

  it('reports a clause it cannot read instead of guessing', () => {
    expect(() => parseIntent('Save ${x} to the shared store as "k" for ever')).toThrow(/cannot read "for ever"/);
  });

  it('YAML sugar and Setup:/Teardown: journeys', async () => {
    const dir = await tmp('yaml');
    await writeFile(join(dir, 'j.yaml'), [
      'name: Uses the store',
      'steps:',
      '  - store: { save: orderId, as: pending-order, ttl: 2 days, namespace: sit }',
      '  - store: { load: pending-order, as: again, default: none }',
      '  - pool: { take: approvable-policies, as: policy, keep: true }',
      '  - pool: { add: "${policy}", to: approvable-policies }',
    ].join('\n'));
    const j = await loadJourneyFile(join(dir, 'j.yaml'));
    expect(j.steps.map((s) => s.args?.op)).toEqual(['save', 'load', 'poolTake', 'poolAdd']);
    expect(j.steps[0].args).toMatchObject({ key: 'pending-order', value: '${orderId}', ttlMs: 172_800_000, namespace: 'sit' });
    const setup = parseEzScript('Setup: Seed reference data\nTags: @data\nReturns: token\n\nSet variable token to "abc"\n');
    expect(setup.tags).toEqual(['setup', 'data']);
    expect(journeyToEzScript(setup)).toMatch(/^Setup: Seed reference data\nTags: @data\n/);
  });

  it('durations and variable names', () => {
    expect(parseTtl('2 days')).toBe(172_800_000);
    expect(parseTtl('90m')).toBe(5_400_000);
    expect(parseTtl('1 week')).toBe(604_800_000);
    expect(variableName('pending-order')).toBe('pending_order');
    expect(variableName('9lives')).toBe('_9lives');
  });
});

describe('file backend', () => {
  it('hands a value from one run to the next, with namespaces', async () => {
    const dir = await tmp('file');
    const a = new SharedStore({ backend: new FileStoreBackend(dir), namespace: 'sit', env: {} });
    await a.save('pending-order', { id: 'ORD-7', total: 49.5 });
    await a.save('pending-order', 'ORD-UAT', { namespace: 'uat' });
    // A second run: a new process would open the same directory.
    const b = new SharedStore({ backend: new FileStoreBackend(dir), namespace: 'sit', env: {} });
    expect((await b.load('pending-order')).value).toEqual({ id: 'ORD-7', total: 49.5 });
    expect((await b.load('pending-order', { namespace: 'uat' })).value).toBe('ORD-UAT');
    expect(await b.delete('pending-order')).toBe(true);
    await expect(b.load('pending-order')).rejects.toThrow(/No "pending-order" in namespace "sit" of the shared store \(file: .*\)/);
    expect((await b.load('pending-order', { default: 'ORD-0' })).value).toBe('ORD-0');
  });

  it('expires values after their TTL and says so', async () => {
    const dir = await tmp('ttl');
    const s = new SharedStore({ backend: new FileStoreBackend(dir), env: {} });
    await s.save('short', 'v', { ttlMs: 40, source: { journeyId: 'create-order', runId: 'run-1' } });
    expect((await s.load('short')).value).toBe('v');
    await new Promise((r) => setTimeout(r, 80));
    await expect(s.load('short')).rejects.toThrow(/"short" in namespace "default" .* expired at .* \(saved by journey "create-order" in run-1/);
    expect((await s.load('short', { default: 'fallback' })).value).toBe('fallback');
    expect(await s.backend.purgeExpired()).toBe(1);
    await expect(s.load('short')).rejects.toThrow(/No "short"/);
  });

  it('two processes claim from one pool without duplicates', async () => {
    const dir = await tmp('pool');
    const seed = new SharedStore({ backend: new FileStoreBackend(dir), env: {} });
    const items = Array.from({ length: 40 }, (_, i) => `POL-${String(i).padStart(3, '0')}`);
    expect(await seed.poolAdd('approvable-policies', items)).toEqual({ added: 40, skipped: 0 });
    expect(await seed.poolAdd('approvable-policies', items.slice(0, 5))).toEqual({ added: 0, skipped: 5 });
    const worker = join(dir, 'worker.mts');
    await writeFile(worker, `
      import { FileStoreBackend, SharedStore } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/store/index.ts')).href)};
      const s = new SharedStore({ backend: new FileStoreBackend(${JSON.stringify(dir)}), env: {} });
      const got: string[] = [];
      // Both workers start claiming at the same moment.
      while (Date.now() < Number(process.argv[3])) await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; ; i++) {
        try { got.push(String((await s.take('approvable-policies', 'w' + process.argv[2] + '#' + i)).value)); } catch { break; }
      }
      process.stdout.write(JSON.stringify(got));
    `);
    const tsx = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
    const startAt = String(Date.now() + 4000);
    const run = (id: string) => new Promise<string[]>((res, rej) => {
      const p = spawn(process.execPath, ['--import', tsx, worker, id, startAt], { env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('exit', (code) => (code === 0 ? res(JSON.parse(out) as string[]) : rej(new Error(`worker ${id} exited ${code}: ${err}`))));
    });
    const [w1, w2] = await Promise.all([run('1'), run('2')]);
    const all = [...w1, ...w2];
    expect(all.length).toBe(40);
    expect(new Set(all).size).toBe(40);
    expect(w1.length).toBeGreaterThan(0);
    expect(w2.length).toBeGreaterThan(0);
    expect((await seed.count('approvable-policies')).available).toBe(0);
  }, 120_000);

  it('consumes an item when the journey passes, releases it when it fails, keeps it consumed when configured', async () => {
    const dir = await tmp('settle');
    const s = new SharedStore({ backend: new FileStoreBackend(dir), env: {}, pools: { strict: { releaseOnFailure: false } } });
    await s.poolAdd('p', ['a', 'b']);
    await s.poolAdd('strict', ['x']);
    const first = await s.take('p', 'j1#1');
    await s.settle('j1#1', false);
    expect((await s.count('p')).available).toBe(2);
    await s.take('p', 'j1#2');
    await s.settle('j1#2', true);
    expect((await s.count('p')).total).toBe(1);
    expect(first.value).toBe('a');
    await s.take('strict', 'j2#1');
    await s.settle('j2#1', false);
    expect((await s.count('strict')).total).toBe(0);
    await expect(s.take('strict', 'j3#1')).rejects.toThrow(/Pool "strict" \(namespace "default"\) is empty/);
  });

  it('frees the claims of a crashed run when they expire', async () => {
    const dir = await tmp('crash');
    const crashed = new SharedStore({ backend: new FileStoreBackend(dir), env: {}, claimTtlMs: 50 });
    await crashed.poolAdd('p', ['only']);
    await crashed.take('p', 'gone#1');
    const next = new SharedStore({ backend: new FileStoreBackend(dir), env: {} });
    await expect(next.take('p', 'n#1')).rejects.toThrow(/all 1 are claimed/);
    await new Promise((r) => setTimeout(r, 80));
    expect((await next.take('p', 'n#1')).value).toBe('only');
  });

  it('seeds a pool from a data file once', async () => {
    const dir = await tmp('seed');
    await writeFile(join(dir, 'policies.csv'), 'policyNo,state\nP-1,new\nP-2,new\nP-3,new\n');
    const s = new SharedStore({ backend: new FileStoreBackend(join(dir, 'store')), env: {}, baseDir: dir, pools: { pol: { from: 'policies.csv', column: 'policyNo' } } });
    expect((await s.count('pol')).available).toBe(3);
    expect((await s.take('pol', 'a#1')).value).toBe('P-1');
    await s.settle('a#1', true);
    const again = new SharedStore({ backend: new FileStoreBackend(join(dir, 'store')), env: {}, baseDir: dir, pools: { pol: { from: 'policies.csv', column: 'policyNo' } } });
    expect((await again.count('pol')).total).toBe(2);
    const rows = await again.seed('rows', 'policies.csv');
    expect(rows.added).toBe(3);
    expect((await again.take('rows', 'b#1')).value).toEqual({ policyNo: 'P-1', state: 'new' });
  });
});

describe('secrets', () => {
  it('are sealed at rest, registered with the masker and need the key', async () => {
    const dir = await tmp('secret');
    const masker = new SecretMasker();
    const s = new SharedStore({ backend: new FileStoreBackend(dir), env: { EZTEST_STORE_KEY: KEY }, addSecret: (v) => masker.add(v) });
    await s.save('api-token', 'tok-SECRET-value-42', { secret: true });
    await s.poolAdd('creds', [{ user: 'u1', password: 'pw-SECRET-1' }], { secret: true });
    const files = await readdir(join(dir, 'default'), { recursive: true });
    for (const f of files.filter((x) => String(x).endsWith('.json'))) {
      const text = await readFile(join(dir, 'default', String(f)), 'utf8');
      expect(text).not.toContain('tok-SECRET-value-42');
      expect(text).not.toContain('pw-SECRET-1');
    }
    expect(masker.mask('the token is tok-SECRET-value-42')).toBe('the token is ****');
    const other = new SharedStore({ backend: new FileStoreBackend(dir), env: { EZTEST_STORE_KEY: KEY } });
    expect((await other.load('api-token')).value).toBe('tok-SECRET-value-42');
    expect((await other.take('creds', 'x#1')).value).toEqual({ user: 'u1', password: 'pw-SECRET-1' });
    const noKey = new SharedStore({ backend: new FileStoreBackend(dir), env: {} });
    await expect(noKey.load('api-token')).rejects.toThrow(/need a key: set EZTEST_STORE_KEY/);
    const wrong = new SharedStore({ backend: new FileStoreBackend(dir), env: { EZTEST_STORE_KEY: 'a-different-key-0123456789' } });
    await expect(wrong.load('api-token')).rejects.toThrow(/could not be decrypted/);
    const c = new StoreCipher(KEY);
    expect(c.open(c.seal({ a: [1, 'b'] }))).toEqual({ a: [1, 'b'] });
  });
});

describe('pipeline outputs', () => {
  it('Azure Pipelines logging commands are escaped; secrets are issecret', () => {
    expect(vsoSetVariable('pending_order', 'ORD-1')).toBe('##vso[task.setvariable variable=pending_order;isOutput=true]ORD-1');
    expect(vsoSetVariable('x', 'a;b]c\n100%', { secret: true })).toBe('##vso[task.setvariable variable=x;isOutput=true;issecret=true]a;b]c%0A100%AZP25');
    expect(githubOutputLine('k', 'one')).toBe('k=one\n');
    expect(githubOutputLine('k', 'a\nb')).toMatch(/^k<<(EZTEST_[0-9a-f]{12})\na\nb\n\1\n$/);
    const f = formatOutputs([{ variable: 'tok', key: 'tok', plain: 'plain-secret', secret: true, sealed: 'EZS1:sealed' }], { GITHUB_OUTPUT: '/x', TF_BUILD: 'True' });
    expect(f.lines).toEqual(['##vso[task.setvariable variable=tok;isOutput=true;issecret=true]plain-secret', '::add-mask::plain-secret']);
    expect(f.githubOutput).toBe('tok=EZS1:sealed\n');
    expect(formatOutputs([{ variable: 'a', key: 'a', plain: '1' }], {}).lines).toEqual([]);
  });

  it('a later stage on another agent loads the values through EZTEST_STORE_IMPORT, GITHUB_OUTPUT or EZTEST_STORE_<KEY>', async () => {
    const stage1 = await tmp('stage1');
    const ghOut = join(stage1, 'github-output');
    await writeFile(ghOut, '');
    const lines: string[] = [];
    const s1 = new SharedStore({ backend: new FileStoreBackend(join(stage1, 'store')), namespace: 'sit', env: { TF_BUILD: 'True', GITHUB_OUTPUT: ghOut, EZTEST_STORE_KEY: KEY } });
    await s1.save('pending-order', { id: 'ORD-9' }, { pipeline: true });
    await s1.save('api-token', 'tok-PIPE-secret', { pipeline: true, secret: true });
    await s1.save('local-only', 'x');
    const r = await s1.finish({ runDir: join(stage1, 'run'), outputDir: stage1, runId: 'run-1', pipeline: 'deploy-sit', out: (l) => lines.push(l) });
    expect(r.entries).toBe(2);
    expect(lines).toContain('##vso[task.setvariable variable=pending_order;isOutput=true]{"id":"ORD-9"}');
    expect(lines).toContain('##vso[task.setvariable variable=api_token;isOutput=true;issecret=true]tok-PIPE-secret');
    const gh = await readFile(ghOut, 'utf8');
    expect(gh).toContain('pending_order={"id":"ORD-9"}\n');
    expect(gh).not.toContain('tok-PIPE-secret');
    const exported = await readFile(join(stage1, 'store-export.json'), 'utf8');
    expect(existsSync(join(stage1, 'run', 'store-export.json'))).toBe(true);
    expect(exported).not.toContain('tok-PIPE-secret');
    const doc = JSON.parse(exported);
    expect(doc).toMatchObject({ kind: 'eztest-store-export', runId: 'run-1', pipeline: 'deploy-sit' });
    expect(doc.entries.map((e: { key: string }) => e.key).sort()).toEqual(['api-token', 'pending-order']);

    // Stage 2: a fresh agent (empty store), the artifact downloaded.
    const stage2 = await tmp('stage2');
    const s2 = new SharedStore({ backend: new FileStoreBackend(join(stage2, 'store')), namespace: 'sit', env: { EZTEST_STORE_IMPORT: join(stage1, 'store-export.json'), EZTEST_STORE_KEY: KEY } });
    expect(await s2.load('pending-order')).toMatchObject({ value: { id: 'ORD-9' }, from: 'import' });
    expect((await s2.load('api-token')).value).toBe('tok-PIPE-secret');
    await expect(s2.load('local-only')).rejects.toThrow(/No "local-only"/);
    // A value this stage saves itself wins over the import.
    await s2.save('pending-order', 'ORD-NEW');
    expect((await s2.load('pending-order')).value).toBe('ORD-NEW');
    // Azure stage dependencies mapped into an environment variable.
    const s3 = new SharedStore({ backend: new FileStoreBackend(join(stage2, 'other')), namespace: 'sit', env: { EZTEST_STORE_PENDING_ORDER: '{"id":"ORD-9"}' } });
    expect(await s3.load('pending-order')).toEqual({ value: { id: 'ORD-9' }, from: 'environment' });
    // An unmapped Azure macro is not a value.
    const s4 = new SharedStore({ backend: new FileStoreBackend(join(stage2, 'other')), env: { EZTEST_STORE_PENDING_ORDER: "$[ stageDependencies.A.b.outputs['eztest.pending_order'] ]" } });
    await expect(s4.load('pending-order')).rejects.toThrow(/No "pending-order"/);
  });
});
