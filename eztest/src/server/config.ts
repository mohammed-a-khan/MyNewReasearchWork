/**
 * Results-server configuration (`eztest-server.yaml`, flags, or environment).
 * `${VAR}` anywhere in the file is replaced from the environment, so secrets
 * (database password, OIDC client secret) never need to be in the file.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ROLES } from './auth.js';

const Db = z.discriminatedUnion('driver', [
  z.object({ driver: z.literal('sqlite'), file: z.string().min(1).optional() }),
  z.object({
    driver: z.literal('postgres'), connectionString: z.string().optional(), host: z.string().optional(), port: z.number().int().optional(),
    database: z.string().optional(), user: z.string().optional(), password: z.string().optional(), ssl: z.unknown().optional(),
  }),
  z.object({
    driver: z.literal('mssql'), connectionString: z.string().optional(), server: z.string().optional(), port: z.number().int().optional(),
    database: z.string().optional(), user: z.string().optional(), password: z.string().optional(), options: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export const ServerConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(8080),
  dataDir: z.string().min(1).default('eztest-server-data'),
  /** The audit log's key file (outside the database; created on first start). Default <dataDir>/audit-key.json. */
  auditKeyFile: z.string().min(1).optional(),
  /** External URL (used for the OIDC redirect URI and secure cookies), e.g. https://eztest.example.com. */
  publicUrl: z.string().url().optional(),
  /** Behind a TLS-terminating proxy: trust X-Forwarded-For / X-Forwarded-Proto. */
  trustProxy: z.boolean().default(false),
  tls: z.object({ cert: z.string().min(1), key: z.string().min(1) }).optional(),
  database: Db.default({ driver: 'sqlite' }),
  oidc: z
    .object({
      issuer: z.string().url(), clientId: z.string().min(1), clientSecret: z.string().optional(),
      scopes: z.string().optional(), groupsClaim: z.string().optional(), clockSkewS: z.number().int().min(0).optional(),
    })
    .optional(),
  /** Role grants for signed-in people: subject is user:<email>, sub:<id>, group:<name> or "*". */
  access: z.array(z.object({ subject: z.string().min(1), project: z.string().min(1), role: z.enum(ROLES) })).default([]),
  retention: z
    .object({
      /** Delete run evidence after this many days (signed packs are kept). Unset = keep forever. */
      defaultDays: z.number().int().min(1).optional(),
      projects: z.record(z.string(), z.number().int().min(1)).default({}),
      /** How often the retention sweep runs (hours). */
      everyHours: z.number().min(0.01).default(24),
    })
    .prefault({}),
  maxUploadMb: z.number().int().min(1).default(512),
  sessionHours: z.number().min(0.1).default(12),
  /** Allow read-only dashboards without signing in (internal networks only). */
  anonymousRead: z.boolean().default(false),
  /** Requests per minute per client on sign-in and failed-token paths. */
  authRateLimit: z.number().int().min(1).default(20),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

function interpolate(v: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof v === 'string') return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, k: string) => env[k] ?? '');
  if (Array.isArray(v)) return v.map((x) => interpolate(x, env));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolate(x, env)]));
  return v;
}

export async function loadServerConfig(o: { file?: string; cwd?: string; env?: Record<string, string | undefined>; overrides?: Record<string, unknown> } = {}): Promise<ServerConfig & { baseDir: string }> {
  const cwd = o.cwd ?? process.cwd();
  const env = o.env ?? process.env;
  const file = o.file ? resolve(cwd, o.file) : ['eztest-server.yaml', 'eztest-server.yml'].map((f) => join(cwd, f)).find((f) => existsSync(f));
  let raw: Record<string, unknown> = {};
  if (file) raw = (parseYaml(await readFile(file, 'utf8')) ?? {}) as Record<string, unknown>;
  // Environment shortcuts for containers.
  if (env.EZTEST_SERVER_DATABASE_URL) raw.database = { driver: env.EZTEST_SERVER_DATABASE_URL.startsWith('postgres') ? 'postgres' : 'mssql', connectionString: env.EZTEST_SERVER_DATABASE_URL };
  if (env.EZTEST_SERVER_PUBLIC_URL) raw.publicUrl = env.EZTEST_SERVER_PUBLIC_URL;
  const merged = { ...(interpolate(raw, env) as Record<string, unknown>), ...(o.overrides ?? {}) };
  const r = ServerConfigSchema.safeParse(merged);
  if (!r.success) throw new Error(`Invalid server configuration${file ? ` (${file})` : ''}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const baseDir = file ? resolve(file, '..') : cwd;
  const cfg = r.data;
  cfg.dataDir = isAbsolute(cfg.dataDir) ? cfg.dataDir : resolve(baseDir, cfg.dataDir);
  if (cfg.auditKeyFile && !isAbsolute(cfg.auditKeyFile)) cfg.auditKeyFile = resolve(baseDir, cfg.auditKeyFile);
  return { ...cfg, baseDir };
}
