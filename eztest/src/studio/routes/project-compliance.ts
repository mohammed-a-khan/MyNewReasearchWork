/**
 * Project › Compliance: signed, tamper-evident evidence packs for a run
 * (profiles generic / csa-part11 / sox), offline verification of a pack
 * (picked from the project or uploaded) and the traceability table.
 *
 * Signing uses a Studio key pair kept in `.eztest/keys/` (private key mode
 * 0600, never served; generated on explicit request). The public key can be
 * downloaded and handed to auditors.
 */
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PROFILES,
  createEvidencePack,
  generateSigningKey,
  keyFingerprint,
  loadPublicKey,
  renderPackSummary,
  verifyEvidencePack,
  type PackManifest,
  type RegulatoryProfileId,
} from '../../evidence-pack/index.js';
import type { StudioApp } from '../app.js';
import { HttpError, sendJson, sendText } from '../http.js';
import { assertRunId, listRuns } from '../runs.js';
import { relPosix } from '../security.js';
import { decodeUpload, findProjectFiles, projectPath } from './assurance-shared.js';
import type { StudioRoute } from './route.js';

function keyFiles(app: StudioApp): { dir: string; priv: string; pub: string } {
  const dir = resolve(app.cwd, '.eztest', 'keys');
  return { dir, priv: join(dir, 'studio-signing.key.pem'), pub: join(dir, 'studio-signing.pub.pem') };
}

async function keyInfo(app: StudioApp): Promise<{ exists: boolean; fingerprint?: string; publicKeyPem?: string; createdAt?: string }> {
  const k = keyFiles(app);
  if (!existsSync(k.priv) || !existsSync(k.pub)) return { exists: false };
  const pem = await readFile(k.pub, 'utf8');
  return { exists: true, fingerprint: keyFingerprint(loadPublicKey(pem)), publicKeyPem: pem, createdAt: (await stat(k.pub)).mtime.toISOString() };
}

function manifestView(m: PackManifest | undefined) {
  if (!m) return undefined;
  return {
    createdAt: m.createdAt,
    signer: m.signer,
    key: m.key,
    profile: m.profile,
    run: { runId: m.run.runId, startedAt: m.run.startedAt, summary: m.run.summary, journeys: m.run.journeys },
    evidence: { head: m.evidence.head, entries: m.evidence.entries, included: m.evidence.included, excluded: m.evidence.excluded.length },
    files: m.files.length,
    traceability: m.traceability,
    untracedJourneys: m.untracedJourneys,
  };
}

async function listPacks(app: StudioApp): Promise<Array<{ path: string; size: number; mtime: string; runId?: string }>> {
  const out: Array<{ path: string; size: number; mtime: string; runId?: string }> = [];
  const outDir = await app.outputDir();
  for (const r of (await listRuns(outDir)).slice(0, 60)) {
    const dir = join(outDir, r.runId);
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const n of names.filter((x) => /^evidence-pack.*\.zip$/i.test(x))) {
      const st = await stat(join(dir, n));
      out.push({ path: relPosix(app.cwd, join(dir, n)), size: st.size, mtime: st.mtime.toISOString(), runId: r.runId });
    }
  }
  for (const f of await findProjectFiles(app, ['.zip'], { maxDepth: 3 })) if (!out.some((x) => x.path === f.path)) out.push(f);
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export const complianceRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/project/compliance',
    summary: 'Signing key status, profiles, runs and existing evidence packs',
    async handler({ res, app }) {
      const runs = (await listRuns(await app.outputDir())).filter((r) => r.summary && !r.cancelled).slice(0, 40);
      sendJson(res, 200, {
        key: await keyInfo(app),
        profiles: Object.values(PROFILES).map((p) => ({ id: p.id, title: p.title, requireTraceability: p.requireTraceability, requirementLabel: p.requirementLabel, signatureMeaning: p.signatureMeaning, statements: p.statements })),
        runs,
        packs: await listPacks(app),
      });
    },
  },
  {
    method: 'POST',
    path: '/api/project/compliance/key',
    summary: 'Generate the Studio signing key pair (ed25519; private key never leaves .eztest/keys)',
    async handler({ res, app, body }) {
      const k = keyFiles(app);
      if (existsSync(k.priv) && body.replace !== true) throw new HttpError(409, 'A signing key already exists; replacing it needs confirmation', { confirm: true });
      const pair = generateSigningKey();
      await mkdir(k.dir, { recursive: true, mode: 0o700 });
      await writeFile(k.priv, pair.privateKeyPem, { mode: 0o600 });
      await chmod(k.priv, 0o600);
      await writeFile(k.pub, pair.publicKeyPem);
      sendJson(res, 200, { key: await keyInfo(app) });
    },
  },
  {
    method: 'POST',
    path: '/api/project/compliance/pack',
    summary: 'Create a signed evidence pack for a run',
    async handler({ res, app, body }) {
      const runId = String(body.runId ?? '');
      assertRunId(runId);
      const profile = String(body.profile ?? 'generic') as RegulatoryProfileId;
      if (!(profile in PROFILES)) throw new HttpError(400, `Unknown profile "${profile}"`);
      const signer = (body.signer ?? {}) as Record<string, unknown>;
      const name = typeof signer.name === 'string' ? signer.name.trim() : '';
      const role = typeof signer.role === 'string' ? signer.role.trim() : '';
      if (!name || !role) throw new HttpError(400, 'The signer name and role are required');
      const k = keyFiles(app);
      if (!existsSync(k.priv)) throw new HttpError(412, 'No signing key yet: generate the Studio signing key first');
      const runDir = join(await app.outputDir(), runId);
      if (!existsSync(join(runDir, 'run.json'))) throw new HttpError(404, `Run ${runId} not found`);
      const outFile = join(runDir, `evidence-pack-${profile}.zip`);
      try {
        const r = await createEvidencePack(runDir, outFile, {
          privateKeyPem: await readFile(k.priv, 'utf8'),
          signer: { name: name.slice(0, 120), role: role.slice(0, 120), meaning: typeof signer.meaning === 'string' && signer.meaning.trim() ? signer.meaning.trim().slice(0, 300) : undefined },
          regulatoryProfile: profile,
          secretPolicy: 'refuse',
        });
        await writeFile(outFile.replace(/\.zip$/i, '') + '-summary.html', renderPackSummary(r.manifest, { format: 'html' }));
        app.hub.publish('project', { type: 'evidence-pack', runId, path: relPosix(app.cwd, outFile) });
        sendJson(res, 200, { path: relPosix(app.cwd, outFile), sha256: r.sha256, bytes: r.bytes, manifest: manifestView(r.manifest), summary: `/runs/${encodeURIComponent(runId)}/evidence-pack-${profile}-summary.html` });
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
    },
  },
  {
    method: 'POST',
    path: '/api/project/compliance/verify',
    summary: 'Verify an evidence pack (signature, every file hash, the evidence chain)',
    async handler({ res, app, body }) {
      let file: string;
      let temp: string | undefined;
      if (typeof body.path === 'string' && body.path) {
        file = projectPath(app, body.path, { exts: ['.zip'], allowOutput: true });
        if (!existsSync(file)) throw new HttpError(404, 'Pack not found');
      } else {
        const bytes = decodeUpload(body.data);
        if (bytes.subarray(0, 2).toString('latin1') !== 'PK') throw new HttpError(400, 'The file is not a ZIP');
        temp = await mkdtemp(join(tmpdir(), 'eztest-pack-'));
        file = join(temp, 'pack.zip');
        await writeFile(file, bytes);
      }
      let pub = typeof body.publicKeyPem === 'string' && body.publicKeyPem.trim() ? body.publicKeyPem : undefined;
      if (!pub) {
        const k = keyFiles(app);
        if (!existsSync(k.pub)) throw new HttpError(400, 'Give the signer\'s public key (PEM); the Studio has no key of its own yet');
        pub = await readFile(k.pub, 'utf8');
      }
      try {
        loadPublicKey(pub);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      try {
        const r = await verifyEvidencePack(file, pub);
        sendJson(res, 200, { ok: r.ok, signatureValid: r.signatureValid, filesChecked: r.filesChecked, problems: r.problems, evidence: r.evidence, manifest: manifestView(r.manifest) });
      } finally {
        if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  },
  {
    method: ['GET', 'HEAD'],
    path: '/api/project/compliance/download',
    summary: 'Download an evidence pack or the Studio public key',
    async handler({ res, app, query, method }) {
      if (query.get('what') === 'public-key') {
        const k = keyFiles(app);
        if (!existsSync(k.pub)) throw new HttpError(404, 'No public key');
        res.setHeader('Content-Disposition', 'attachment; filename="eztest-studio-signing.pub.pem"');
        return sendText(res, 200, 'application/x-pem-file', await readFile(k.pub), method === 'HEAD');
      }
      const abs = projectPath(app, query.get('path'), { exts: ['.zip'] });
      if (!existsSync(abs)) throw new HttpError(404, 'Pack not found');
      res.setHeader('Content-Disposition', `attachment; filename="${relPosix(app.cwd, abs).split('/').pop()}"`);
      sendText(res, 200, 'application/zip', await readFile(abs), method === 'HEAD');
    },
  },
];
