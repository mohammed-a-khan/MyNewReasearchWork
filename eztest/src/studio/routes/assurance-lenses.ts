/**
 * Lens viewers: visual diff (baseline / actual / diff images, ignore regions,
 * baseline approval recorded in an approvals evidence vault), accessibility
 * findings with element boxes, security findings with remediation, and the
 * authorization matrix / IDOR probes run server side with role tokens that
 * never reach the browser.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { EvidenceVault, sha256, verifyEvidence } from '../../core/index.js';
import {
  VISUAL_MASKS_FILE,
  loadVisualMasks,
  probeIdor,
  runAuthorizationMatrix,
  type A11yScanResult,
  type AuthzCase,
  type SecurityScanResult,
  type ChangeGroup,
  type VisualMaskBox,
  type VisualResult,
} from '../../lenses/index.js';
import { branchSlug, currentBranchSync } from '../../git/branch.js';
import type { StudioApp } from '../app.js';
import { HttpError, sendJson, sendText } from '../http.js';
import { relPosix } from '../security.js';
import { assuranceRuns, lensFindings, loadRun, masker, projectPath, readRunJson, runAssetUrl, vaultFor, type LensStepFindings, type LoadedRun } from './assurance-shared.js';
import { slugify } from '../../core/index.js';
import type { StudioRoute } from './route.js';

// ------------------------------------------------------------------ visual

const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}$/;

function visualDirs(app: StudioApp): { baselines: string; output: string; approvals: string } {
  const base = resolve(app.cwd, '.eztest');
  // Branch-scoped baselines (vcs.branchScope.baselines): once a run on this branch created its directory, approvals go there.
  const shared = join(base, 'baselines');
  const branch = currentBranchSync(app.cwd, app.env);
  const scoped = branch ? join(shared, 'branches', branchSlug(branch)) : shared;
  return { baselines: existsSync(scoped) ? scoped : shared, output: join(base, 'visual-output'), approvals: join(base, 'approvals') };
}

function imageFile(app: StudioApp, kind: string, name: string, branch?: string): string {
  if (!NAME.test(name)) throw new HttpError(400, 'Invalid baseline name');
  if (branch !== undefined && !NAME.test(branch)) throw new HttpError(400, 'Invalid branch');
  const d = visualDirs(app);
  // Baselines approved on a git branch live in branches/<branch>/ (see lenses/visual-baselines.ts).
  if (kind === 'baseline') return join(branch ? join(d.baselines, 'branches', slugify(branch)) : d.baselines, `${name}.png`);
  if (kind === 'actual') return join(d.output, `${name}.actual.png`);
  if (kind === 'diff') return join(d.output, `${name}.diff.png`);
  throw new HttpError(400, 'kind must be baseline, actual or diff');
}

async function imageUrl(app: StudioApp, kind: string, name: string, branch?: string): Promise<string | undefined> {
  const f = imageFile(app, kind, name, branch);
  if (!existsSync(f)) return undefined;
  const v = Math.round((await stat(f)).mtimeMs);
  return `/api/assurance/visual/image?kind=${kind}&name=${encodeURIComponent(name)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}&v=${v}`;
}

/** Visual results of a run: the per-step lens and "Expect ... to look like the baseline" steps (several viewports each). */
async function visualFindings(r: LoadedRun): Promise<Array<LensStepFindings<VisualResult>>> {
  const out = await lensFindings<VisualResult>(r, 'visual');
  const seen = new Set(out.map((x) => x.evidencePath));
  // Visual assertion steps store their findings as evidence of the step (not as lens output).
  for (const e of r.evidence.values()) {
    if (e.kind !== 'data' || !/(?:^|\/)lens-visual-/.test(e.path) || seen.has(e.path)) continue;
    const j = r.run.journeys.find((x) => x.journeyId === e.journeyId);
    const s = j?.steps.find((x) => x.stepId === e.stepId) ?? j?.steps.flatMap((x) => x.children ?? []).find((x) => x.stepId === e.stepId);
    const findings = (await readRunJson<LensStepFindings<VisualResult>['findings']>(r, e.path)) ?? [];
    const shot = [...r.evidence.values()].find((x) => x.kind === 'screenshot' && x.stepId === e.stepId && x.journeyId === e.journeyId);
    out.push({ journeyId: e.journeyId ?? '', journeyName: j?.name ?? e.journeyId ?? '', stepId: e.stepId ?? '', intent: s?.intent ?? e.description ?? '', status: s?.status ?? 'failed', evidencePath: e.path, findings, screenshot: shot ? runAssetUrl(r.id, shot.path) : undefined });
  }
  return out;
}

/** Accessibility results of a run: the per-step lens and "Check accessibility" steps (stored as evidence of the step). */
async function a11yFindings(r: LoadedRun): Promise<Array<LensStepFindings<A11yScanResult>>> {
  const out = await lensFindings<A11yScanResult>(r, 'a11y');
  const seen = new Set(out.map((x) => x.evidencePath));
  for (const e of r.evidence.values()) {
    if (e.kind !== 'data' || !/(?:^|\/)lens-a11y-/.test(e.path) || seen.has(e.path)) continue;
    const j = r.run.journeys.find((x) => x.journeyId === e.journeyId);
    const s = j?.steps.find((x) => x.stepId === e.stepId) ?? j?.steps.flatMap((x) => x.children ?? []).find((x) => x.stepId === e.stepId);
    const findings = (await readRunJson<LensStepFindings<A11yScanResult>['findings']>(r, e.path)) ?? [];
    const shot = [...r.evidence.values()].find((x) => x.kind === 'screenshot' && x.stepId === e.stepId && x.journeyId === e.journeyId);
    out.push({ journeyId: e.journeyId ?? '', journeyName: j?.name ?? e.journeyId ?? '', stepId: e.stepId ?? '', intent: s?.intent ?? e.description ?? '', status: s?.status ?? 'failed', evidencePath: e.path, findings, screenshot: shot ? runAssetUrl(r.id, shot.path) : undefined });
  }
  return out;
}

function sanitizeBoxes(v: unknown): VisualMaskBox[] {
  if (!Array.isArray(v)) throw new HttpError(400, '"boxes" must be a list');
  if (v.length > 200) throw new HttpError(400, 'Too many ignore regions');
  return v.map((b, i) => {
    const o = (b ?? {}) as Record<string, unknown>;
    const n = (k: string) => {
      const x = Number(o[k]);
      if (!Number.isFinite(x) || x < 0 || x > 100_000) throw new HttpError(400, `boxes[${i}].${k} must be a non-negative number`);
      return Math.round(x);
    };
    const box: VisualMaskBox = { x: n('x'), y: n('y'), width: n('width'), height: n('height') };
    if (box.width < 1 || box.height < 1) throw new HttpError(400, `boxes[${i}] is empty`);
    if (typeof o.label === 'string' && o.label.trim()) box.label = o.label.trim().slice(0, 80);
    return box;
  });
}

async function listApprovals(app: StudioApp): Promise<Array<Record<string, unknown>>> {
  const dir = visualDirs(app).approvals;
  if (!existsSync(dir)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const name of (await readdir(dir)).sort().reverse().slice(0, 50)) {
    const rec = join(dir, name, 'approval.json');
    if (!existsSync(rec)) continue;
    try {
      const data = JSON.parse(await readFile(rec, 'utf8')) as Record<string, unknown>;
      const v = await verifyEvidence(join(dir, name));
      out.push({ id: name, ...data, verified: v.ok, entries: v.entries, head: v.head, problems: v.problems });
    } catch {
      out.push({ id: name, verified: false, problems: ['approval.json unreadable'] });
    }
  }
  return out;
}

// ------------------------------------------------------------------ security remediation

const REMEDIATION: Record<string, string> = {
  'csp-missing': 'Send a Content-Security-Policy header. Start with default-src \'self\'; script-src \'self\'; object-src \'none\'; base-uri \'none\'; frame-ancestors \'none\' and tighten from there.',
  'csp-unsafe-inline': "Remove 'unsafe-inline' from script-src; move inline scripts to files or allow them with a per-response nonce or a hash.",
  'csp-unsafe-eval': "Remove 'unsafe-eval' from script-src; replace eval/new Function with safe parsing (e.g. JSON.parse).",
  'frame-protection-missing': "Add frame-ancestors 'none' (or 'self') to the CSP, or X-Frame-Options: DENY, to prevent clickjacking.",
  'xcto-missing': 'Send X-Content-Type-Options: nosniff on every response so browsers do not MIME-sniff content into scripts.',
  'hsts-missing': 'Send Strict-Transport-Security: max-age=31536000; includeSubDomains on HTTPS responses.',
  'hsts-short': 'Raise the HSTS max-age to at least 15552000 (180 days), ideally one year.',
  'version-disclosure': 'Remove version numbers from Server / X-Powered-By headers (server and framework configuration).',
  'cookie-no-httponly': 'Set the HttpOnly attribute on this cookie so scripts (and XSS payloads) cannot read it.',
  'cookie-no-secure': 'Set the Secure attribute so the cookie is never sent over plain HTTP.',
  'cookie-no-samesite': 'Set SameSite=Lax (or Strict for session cookies) to limit cross-site request forgery.',
  'cookie-samesite-none-insecure': 'SameSite=None requires Secure; add Secure or use SameSite=Lax.',
  'mixed-content': 'Load every sub-resource over HTTPS (update the URL or serve the asset from the same origin).',
  'authz-violation': 'Enforce authorization on the server for this endpoint and role (deny by default; check ownership and role per request).',
  'idor': 'Check that the authenticated user owns (or may access) the requested object id on every request; do not rely on unguessable ids.',
};

// ------------------------------------------------------------------ authorization helpers

async function tokenFor(app: StudioApp, role: string): Promise<string | undefined> {
  if (role === 'anonymous') return undefined;
  const loaded = await app.config();
  return vaultFor(app, loaded).apiToken(role);
}

function parseCases(v: unknown, roles: string[]): AuthzCase[] {
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, 'Add at least one case');
  if (v.length > 100) throw new HttpError(400, 'At most 100 cases');
  return v.map((c, i) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const path = String(o.path ?? '');
    if (!path.startsWith('/')) throw new HttpError(400, `Case ${i + 1}: the path must start with "/"`);
    const expect = (o.expect ?? {}) as Record<string, unknown>;
    const exp: Record<string, 'allow' | 'deny'> = {};
    for (const r of roles) {
      const x = expect[r];
      if (x !== 'allow' && x !== 'deny') throw new HttpError(400, `Case ${i + 1}: choose allow or deny for ${r}`);
      exp[r] = x;
    }
    const method = String(o.method ?? 'GET').toUpperCase();
    if (!/^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/.test(method)) throw new HttpError(400, `Case ${i + 1}: bad method`);
    return { name: typeof o.name === 'string' && o.name ? o.name : undefined, method, path, expect: exp, body: typeof o.body === 'string' && o.body ? o.body : undefined };
  });
}

const MATRIX_FILE = 'security/authz-matrix.yaml';

// ------------------------------------------------------------------ routes

export const lensRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/assurance/runs',
    summary: 'Recent runs and the assurance data each holds (documents, a11y, visual, security, perf)',
    async handler({ res, app }) {
      sendJson(res, 200, { runs: await assuranceRuns(app) });
    },
  },
  // ---------------------------------------------------------------- visual
  {
    method: 'GET',
    path: /^\/api\/assurance\/visual\/runs\/([^/]+)$/,
    summary: 'Visual comparisons of a run (baseline, actual, diff, masks)',
    async handler({ res, app, params }) {
      const r = await loadRun(app, params[0]);
      const steps = await visualFindings(r);
      const masks = await loadVisualMasks(visualDirs(app).baselines);
      const items = [];
      type Extra = VisualResult & { key?: string; mode?: string; groups?: ChangeGroup[]; branch?: string; fallbackFrom?: string; viewport?: { width: number; height: number }; browser?: string };
      for (const s of steps) {
        const fs = s.findings.filter((x) => x.details && typeof x.details === 'object' && 'name' in x.details);
        if (!fs.length) {
          items.push({ ...s, status: 'error', message: s.findings[0]?.message ?? 'no result', findings: undefined });
          continue;
        }
        for (const f of fs) {
          const d = f.details as Extra;
          const plain = d.name.split('--')[0];
          items.push({
            journeyId: s.journeyId, journeyName: s.journeyName, stepId: s.stepId, intent: s.intent, stepStatus: s.status,
            name: d.name, status: d.status, passed: d.passed, diffPixels: d.diffPixels, diffRatio: d.diffRatio, width: d.width, height: d.height,
            baselineSize: d.baselineSize, maskedBoxes: d.maskedBoxes, message: f.message, severity: f.severity,
            mode: d.mode, key: d.key, viewport: d.viewport, browser: d.browser, branch: d.branch, fallbackFrom: d.fallbackFrom,
            groups: (d.groups ?? []).map((g) => ({ id: g.id, kind: g.kind, summary: g.summary, elements: g.elements, diffPixels: g.diffPixels, regions: g.regions })),
            savedMasks: [...(masks['*'] ?? []).map((m) => ({ ...m, global: true })), ...(masks[plain] ?? masks[d.name] ?? [])],
            baseline: (await imageUrl(app, 'baseline', d.name, d.branch)) ?? (d.branch ? await imageUrl(app, 'baseline', d.name) : undefined),
            actual: await imageUrl(app, 'actual', d.name),
            diff: await imageUrl(app, 'diff', d.name),
            screenshot: s.screenshot,
          });
        }
      }
      // The same DOM change across screenshots (one CSS change, several pages/viewports) is one group: approve it once.
      const groups = new Map<string, { id: string; kind: string; summary: string; diffPixels: number; items: string[] }>();
      for (const it of items) {
        for (const g of ((it as { groups?: Array<{ id: string; kind: string; summary: string; diffPixels: number }> }).groups ?? [])) {
          const cur = groups.get(g.id) ?? { id: g.id, kind: g.kind, summary: g.summary, diffPixels: 0, items: [] };
          cur.diffPixels += g.diffPixels;
          const n = (it as { name: string }).name;
          if (!cur.items.includes(n)) cur.items.push(n);
          groups.set(g.id, cur);
        }
      }
      sendJson(res, 200, { runId: r.id, items, groups: [...groups.values()].sort((a, b) => b.items.length - a.items.length || b.diffPixels - a.diffPixels) });

    },
  },
  {
    method: ['GET', 'HEAD'],
    path: '/api/assurance/visual/image',
    summary: 'Baseline, actual or diff image of a visual comparison',
    async handler({ res, app, query, method }) {
      const branch = query.get('branch');
      const f = imageFile(app, String(query.get('kind') ?? ''), String(query.get('name') ?? ''), branch ? String(branch) : undefined);
      if (!existsSync(f)) throw new HttpError(404, 'Image not found');
      sendText(res, 200, 'image/png', await readFile(f), method === 'HEAD');
    },
  },
  {
    method: 'GET',
    path: '/api/assurance/visual/masks',
    summary: 'Saved ignore regions of the visual lens',
    async handler({ res, app }) {
      sendJson(res, 200, { file: relPosix(app.cwd, join(visualDirs(app).baselines, VISUAL_MASKS_FILE)), masks: await loadVisualMasks(visualDirs(app).baselines) });
    },
  },
  {
    method: 'PUT',
    path: '/api/assurance/visual/masks',
    summary: 'Replace the ignore regions of one baseline (or "*" for all)',
    async handler({ res, app, body }) {
      const name = String(body.name ?? '');
      if (name !== '*' && !NAME.test(name)) throw new HttpError(400, 'Invalid baseline name');
      const boxes = sanitizeBoxes(body.boxes);
      const dir = visualDirs(app).baselines;
      const all = await loadVisualMasks(dir);
      if (boxes.length) all[name] = boxes;
      else delete all[name];
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, VISUAL_MASKS_FILE), JSON.stringify(all, null, 2) + '\n');
      sendJson(res, 200, { ok: true, name, boxes, file: relPosix(app.cwd, join(dir, VISUAL_MASKS_FILE)) });
    },
  },
  {
    method: 'POST',
    path: '/api/assurance/visual/approve',
    summary: 'Approve actual screenshots as new baselines; the approval is recorded in a hash-chained vault',
    async handler({ res, app, body }) {
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) throw new HttpError(400, 'Nothing to approve');
      if (items.length > 500) throw new HttpError(400, 'Too many items');
      const d = visualDirs(app);
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
      const vaultDir = join(d.approvals, `${stamp}-${randomBytes(3).toString('hex')}`);
      const vault = new EvidenceVault(vaultDir);
      await vault.init();
      await mkdir(d.baselines, { recursive: true });
      const approved: Array<Record<string, unknown>> = [];
      const skipped: Array<{ name: string; reason: string }> = [];
      for (const it of items) {
        const o = (it ?? {}) as Record<string, unknown>;
        const name = String(o.name ?? '');
        if (!NAME.test(name)) throw new HttpError(400, `Invalid baseline name ${JSON.stringify(name)}`);
        const branch = typeof o.branch === 'string' && o.branch ? o.branch : undefined;
        const actual = imageFile(app, 'actual', name);
        if (!existsSync(actual)) {
          skipped.push({ name, reason: 'no actual screenshot to approve (it already matches the baseline)' });
          continue;
        }
        const baseline = imageFile(app, 'baseline', name, branch);
        const before = existsSync(baseline) ? sha256(await readFile(baseline)) : null;
        const bytes = await readFile(actual);
        await mkdir(join(baseline, '..'), { recursive: true });
        await copyFile(actual, baseline);
        // The DOM snapshot taken with the screenshot becomes the baseline's (layout/content modes, change grouping).
        const actualDom = actual.replace(/\.actual\.png$/, '.actual.dom.json');
        if (existsSync(actualDom)) await copyFile(actualDom, baseline.replace(/\.png$/, '.dom.json'));
        const ref = await vault.store('screenshot', `baselines/${name}.png`, bytes, { journeyId: typeof o.journeyId === 'string' ? o.journeyId : undefined, stepId: typeof o.stepId === 'string' ? o.stepId : undefined, description: `approved baseline ${name}` });
        approved.push({ name, previousSha256: before, sha256: ref.sha256, evidenceId: ref.id, runId: typeof o.runId === 'string' ? o.runId : undefined, journeyId: o.journeyId, stepId: o.stepId, ...(branch ? { branch } : {}), ...(typeof o.group === 'string' ? { group: o.group.slice(0, 40) } : {}) });
      }
      if (!approved.length) {
        sendJson(res, 200, { approved, skipped, vault: undefined });
        return;
      }
      let approver = 'unknown';
      try {
        approver = userInfo().username;
      } catch {
        approver = 'unknown';
      }
      const record = { kind: 'visual-baseline-approval', approvedAt: new Date().toISOString(), approver, via: 'EZTest Studio', comment: typeof body.comment === 'string' ? body.comment.slice(0, 500) : undefined, approved, skipped };
      await vault.store('data', 'approval.json', JSON.stringify(record, null, 2), { description: 'visual baseline approval record' });
      const v = await verifyEvidence(vaultDir);
      app.hub.publish('assurance', { type: 'baselines-approved', names: approved.map((a) => a.name) });
      sendJson(res, 200, { approved, skipped, vault: relPosix(app.cwd, vaultDir), verified: v.ok, head: v.head });
    },
  },
  {
    method: 'GET',
    path: '/api/assurance/visual/approvals',
    summary: 'Baseline approval records with their hash-chain verification',
    async handler({ res, app }) {
      sendJson(res, 200, { approvals: await listApprovals(app) });
    },
  },
  // ---------------------------------------------------------------- accessibility
  {
    method: 'GET',
    path: /^\/api\/assurance\/a11y\/runs\/([^/]+)$/,
    summary: 'Accessibility findings of a run (EZTest accessibility engine), per step, with element boxes',
    async handler({ res, app, params }) {
      const r = await loadRun(app, params[0]);
      const steps = await a11yFindings(r);
      const out = steps.map((s) => {
        const f = s.findings.find((x) => x.details && typeof x.details === 'object' && 'violations' in x.details);
        return {
          journeyId: s.journeyId, journeyName: s.journeyName, stepId: s.stepId, intent: s.intent, status: s.status, screenshot: s.screenshot,
          message: f?.message ?? s.findings[0]?.message, severity: f?.severity, scan: f?.details,
        };
      });
      sendJson(res, 200, (await masker(app)).maskDeep({ runId: r.id, steps: out }));
    },
  },
  // ---------------------------------------------------------------- security
  {
    method: 'GET',
    path: /^\/api\/assurance\/security\/runs\/([^/]+)$/,
    summary: 'Security lens findings of a run (headers, cookies, mixed content) with remediation',
    async handler({ res, app, params }) {
      const r = await loadRun(app, params[0]);
      const steps = await lensFindings<SecurityScanResult>(r, 'security');
      const seen = new Map<string, Record<string, unknown>>();
      for (const s of steps) {
        for (const f of s.findings) {
          const scan = f.details;
          if (!scan || !Array.isArray(scan.findings)) continue;
          for (const x of scan.findings) {
            const key = `${x.id}|${x.subject ?? ''}|${x.url}`;
            const cur = seen.get(key);
            if (cur) (cur.steps as string[]).push(`${s.journeyName} › ${s.intent}`);
            else {
              seen.set(key, {
                ...x, category: x.id.startsWith('cookie') ? 'cookies' : x.id === 'mixed-content' ? 'mixed-content' : 'headers',
                remediation: REMEDIATION[x.id] ?? 'Review this finding with the application owner.', steps: [`${s.journeyName} › ${s.intent}`], journeyId: s.journeyId, stepId: s.stepId,
              });
            }
          }
        }
      }
      sendJson(res, 200, (await masker(app)).maskDeep({ runId: r.id, scannedSteps: steps.length, findings: [...seen.values()] }));
    },
  },
  {
    method: 'GET',
    path: '/api/assurance/security/setup',
    summary: 'Roles available for authorization probes and the saved matrix',
    async handler({ res, app }) {
      let roles: Array<{ name: string; api: boolean }> = [];
      let baseUrl: string | undefined;
      try {
        const cfg = (await app.config()).config;
        roles = Object.entries(cfg.identity.roles).map(([name, r]) => ({ name, api: !!r.api }));
        baseUrl = cfg.baseUrl;
      } catch {
        roles = [];
      }
      let matrix: unknown;
      const f = join(app.cwd, MATRIX_FILE);
      if (existsSync(f)) {
        try {
          matrix = parseYaml(await readFile(f, 'utf8'));
        } catch {
          matrix = undefined;
        }
      }
      sendJson(res, 200, { roles: [{ name: 'anonymous', api: true }, ...roles], baseUrl, matrix, matrixFile: MATRIX_FILE, remediation: REMEDIATION });
    },
  },
  {
    method: 'PUT',
    path: '/api/assurance/security/matrix',
    summary: 'Save the authorization matrix definition (security/authz-matrix.yaml)',
    async handler({ res, app, body }) {
      const roles = Array.isArray(body.roles) ? body.roles.map(String) : [];
      if (!roles.length) throw new HttpError(400, 'Pick at least one role');
      const cases = parseCases(body.cases, roles);
      const abs = projectPath(app, MATRIX_FILE, { exts: ['.yaml'] });
      await mkdir(join(app.cwd, 'security'), { recursive: true });
      await writeFile(abs, toYaml({ roles, cases }));
      sendJson(res, 200, { ok: true, path: MATRIX_FILE });
    },
  },
  {
    method: 'POST',
    path: '/api/assurance/security/authz',
    summary: 'Run an authorization matrix (each role × each case) against the configured base URL',
    async handler({ res, app, body }) {
      const roles = Array.isArray(body.roles) ? body.roles.map(String) : [];
      if (!roles.length) throw new HttpError(400, 'Pick at least one role');
      const cases = parseCases(body.cases, roles);
      const loaded = await app.config();
      const baseUrl = loaded.config.baseUrl;
      if (!baseUrl) throw new HttpError(400, 'The configuration has no baseUrl');
      const report = await runAuthorizationMatrix({
        baseUrl,
        roles: roles.map((name) => ({ name, token: () => tokenFor(app, name) })),
        cases,
        timeoutMs: 15_000,
      }).catch((e: Error) => {
        throw new HttpError(422, loaded.masker.mask(e.message));
      });
      const results = report.results.map((x) => ({ ...x, remediation: x.violation ? REMEDIATION['authz-violation'] : undefined }));
      sendJson(res, 200, loaded.masker.maskDeep({ ...report, results, violations: results.filter((x) => x.violation) }));
    },
  },
  {
    method: 'POST',
    path: '/api/assurance/security/idor',
    summary: 'IDOR probe: two roles request each other\'s resources',
    async handler({ res, app, body }) {
      const users = Array.isArray(body.users) ? body.users : [];
      if (users.length !== 2) throw new HttpError(400, 'Give exactly two roles with their resources');
      const loaded = await app.config();
      const baseUrl = loaded.config.baseUrl;
      if (!baseUrl) throw new HttpError(400, 'The configuration has no baseUrl');
      const u = users.map((x, i) => {
        const o = (x ?? {}) as Record<string, unknown>;
        const name = String(o.role ?? '');
        const resources = (Array.isArray(o.resources) ? o.resources : []).map(String).filter((p) => p.startsWith('/'));
        if (!name || !resources.length) throw new HttpError(400, `Role ${i + 1}: pick a role and at least one resource path starting with "/"`);
        return { name, resources, token: () => tokenFor(app, name) };
      }) as [never, never];
      const r = await probeIdor({ baseUrl, users: u, method: typeof body.method === 'string' ? body.method : 'GET', timeoutMs: 15_000 }).catch((e: Error) => {
        throw new HttpError(422, loaded.masker.mask(e.message));
      });
      sendJson(res, 200, { ...r, findings: r.findings.map((f) => ({ ...f, severity: f.verdict === 'vulnerable' ? 'high' : 'info', remediation: f.verdict === 'vulnerable' ? REMEDIATION.idor : undefined })) });
    },
  },
];
