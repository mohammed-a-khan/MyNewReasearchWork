/**
 * Project › Test data: data needs per journey (declared `data:` needs and
 * "Given a Customer as buyer" steps), configured entities and providers,
 * active leases (with releasing of stale ones) and a seeded synthetic data
 * preview with masking rules.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadJourneys } from '../../cli/journeys.js';
import { Synthetic, maskRows, parseWhere, describeConstraints, type MaskRule } from '../../data/index.js';
import type { StudioApp } from '../app.js';
import { HttpError, sendJson } from '../http.js';
import { relPosix } from '../security.js';
import type { StudioRoute } from './route.js';

interface LeaseFile {
  file: string;
  resource?: string;
  owner?: string;
  acquiredAt?: number;
  expiresAt?: number;
  stale: boolean;
  unreadable?: boolean;
}

async function leaseDir(app: StudioApp): Promise<string> {
  try {
    return resolve(app.cwd, (await app.config()).config.data.leaseDir);
  } catch {
    return resolve(app.cwd, '.eztest/leases');
  }
}

async function readLeases(dir: string, now = Date.now()): Promise<LeaseFile[]> {
  if (!existsSync(dir)) return [];
  const out: LeaseFile[] = [];
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.lease')).sort()) {
    try {
      const l = JSON.parse(await readFile(join(dir, f), 'utf8')) as { resource?: string; owner?: string; acquiredAt?: number; expiresAt?: number };
      out.push({ file: f, resource: l.resource, owner: l.owner, acquiredAt: l.acquiredAt, expiresAt: l.expiresAt, stale: typeof l.expiresAt !== 'number' || l.expiresAt <= now });
    } catch {
      out.push({ file: f, stale: true, unreadable: true });
    }
  }
  return out;
}

const DEFAULT_FIELDS: Record<string, string> = { name: 'fullName', email: 'email', phone: 'phone', company: 'company', city: 'city', card: 'card:visa', iban: 'iban:DE', joined: 'date:2023-01-01:2025-12-31' };
const DEFAULT_MASKS: Record<string, MaskRule> = { email: 'email', phone: { type: 'partial', keepStart: 0, keepEnd: 3 }, card: { type: 'partial', keepStart: 0, keepEnd: 4 }, iban: { type: 'partial', keepStart: 4, keepEnd: 2 } };

function parseMask(v: unknown): MaskRule {
  if (v === 'redact' || v === 'hash' || v === 'null' || v === 'email') return v;
  if (v === 'partial') return { type: 'partial', keepStart: 0, keepEnd: 4 };
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.type === 'partial') return { type: 'partial', keepStart: Math.max(0, Math.min(20, Number(o.keepStart) || 0)), keepEnd: Math.max(0, Math.min(20, Number(o.keepEnd ?? 4))) };
    if (o.type === 'hash') return { type: 'hash', length: Math.max(4, Math.min(64, Number(o.length) || 16)) };
  }
  throw new HttpError(400, `Unknown mask rule ${JSON.stringify(v)} (redact, hash, null, email, partial)`);
}

export const dataRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/project/data',
    summary: 'Data needs per journey, entities, providers and leases',
    async handler({ res, app }) {
      let cfg;
      let error: string | undefined;
      try {
        cfg = (await app.config()).config;
      } catch (e) {
        error = (e as Error).message;
      }
      const needs: Array<Record<string, unknown>> = [];
      const parseErrors: Array<{ file: string; message: string }> = [];
      if (cfg) {
        const { journeys, errors } = await loadJourneys([cfg.journeysDir], app.cwd);
        parseErrors.push(...errors.map((e) => ({ file: e.file.startsWith(app.cwd) ? relPosix(app.cwd, e.file) : e.file, message: e.message })));
        for (const j of journeys) {
          const list: Array<Record<string, unknown>> = j.data.map((d) => ({ as: d.as, entity: d.entity, where: describeConstraints(parseWhere(d.where)), strategy: d.strategy, declared: true }));
          for (const s of j.steps) {
            if (s.action !== 'useData') continue;
            const a = s.args ?? {};
            list.push({ as: a.as, entity: a.entity, where: describeConstraints(parseWhere((a.where ?? {}) as Record<string, string>)), strategy: 'find-or-create', declared: false, stepId: s.id });
          }
          needs.push({ journeyId: j.id, name: j.name, needs: list, provider: list.map((n) => (cfg!.data.entities[String(n.entity)]?.provider ?? 'unmapped')) });
        }
      }
      const entities = cfg ? Object.entries(cfg.data.entities).map(([name, e]) => ({ name, provider: e.provider, connection: e.connection, table: e.table, key: e.key, columns: e.columns ?? {} })) : [];
      const providers: Array<{ kind: string; name: string; entities: string[] }> = [];
      for (const e of entities) {
        const name = e.provider === 'synthetic' ? 'synthetic' : `${e.provider}:${e.connection ?? '?'}`;
        const p = providers.find((x) => x.name === name);
        if (p) p.entities.push(e.name);
        else providers.push({ kind: e.provider, name, entities: [e.name] });
      }
      const dir = await leaseDir(app);
      sendJson(res, 200, {
        error,
        seed: cfg?.data.seed ?? 42,
        leaseDir: relPosix(app.cwd, dir),
        leaseTtlSeconds: cfg?.data.leaseTtlSeconds,
        journeys: needs,
        parseErrors,
        entities,
        providers,
        leases: await readLeases(dir),
        generators: ['firstName', 'lastName', 'fullName', 'email', 'phone', 'company', 'street', 'city', 'postcode', 'country', 'region', 'int:1:100', 'float:0:1', 'date:2024-01-01:2024-12-31', 'businessDay', 'card:visa', 'iban:DE', 'uuid', 'bool', 'edge:sql', 'edge:unicode', 'edge:rtl', 'edge:html'],
      });
    },
  },
  {
    method: 'POST',
    path: '/api/project/data/leases/release-stale',
    summary: 'Delete expired (or unreadable) lease files',
    async handler({ res, app }) {
      const dir = await leaseDir(app);
      const released: string[] = [];
      for (const l of await readLeases(dir)) {
        if (!l.stale) continue;
        // Re-check right before deleting: a lease may have been renewed meanwhile.
        const again = (await readLeases(dir)).find((x) => x.file === l.file);
        if (!again?.stale) continue;
        await unlink(join(dir, l.file)).catch(() => undefined);
        released.push(l.resource ?? l.file);
      }
      sendJson(res, 200, { released, leases: await readLeases(dir) });
    },
  },
  {
    method: 'POST',
    path: '/api/project/data/preview',
    summary: 'Seeded synthetic records (deterministic) with a masked view',
    async handler({ res, app, body }) {
      const count = Math.max(1, Math.min(50, Number(body.count) || 10));
      let fields: Record<string, string> = DEFAULT_FIELDS;
      if (typeof body.entity === 'string' && body.entity) {
        const cfg = (await app.config()).config;
        const e = cfg.data.entities[body.entity];
        if (!e) throw new HttpError(404, `Unknown entity "${body.entity}"`);
        if (!e.columns || !Object.keys(e.columns).length) throw new HttpError(400, `Entity "${body.entity}" defines no columns to generate`);
        fields = e.columns;
      } else if (body.fields && typeof body.fields === 'object') {
        fields = Object.fromEntries(Object.entries(body.fields as Record<string, unknown>).filter(([k]) => /^[\w.-]{1,60}$/.test(k)).map(([k, v]) => [k, String(v)]));
        if (!Object.keys(fields).length) throw new HttpError(400, 'Add at least one field');
      }
      const seed = typeof body.seed === 'number' || (typeof body.seed === 'string' && body.seed) ? (body.seed as string | number) : 42;
      const s = new Synthetic(seed);
      const rows: Array<Record<string, unknown>> = [];
      for (let i = 0; i < count; i++) {
        const r: Record<string, unknown> = {};
        for (const [k, spec] of Object.entries(fields)) {
          try {
            r[k] = s.byName(spec.replace(/^gen:/, ''));
          } catch (e) {
            throw new HttpError(400, `${k}: ${(e as Error).message}`);
          }
        }
        rows.push(r);
      }
      const masks: Record<string, MaskRule> = body.masks && typeof body.masks === 'object'
        ? Object.fromEntries(Object.entries(body.masks as Record<string, unknown>).filter(([, v]) => v !== '' && v !== 'none').map(([k, v]) => [k, parseMask(v)]))
        : Object.fromEntries(Object.entries(DEFAULT_MASKS).filter(([k]) => k in fields));
      sendJson(res, 200, { seed, fields, masks, rows, masked: maskRows(rows, masks, { salt: `eztest-studio-${seed}` }) });
    },
  },
];
