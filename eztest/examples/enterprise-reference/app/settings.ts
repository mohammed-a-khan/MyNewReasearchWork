/**
 * Settings of the Larkspur Mutual reference system, read once from the
 * environment. Everything has a local default so `node server.ts` just works.
 *
 *   REF_HOST            bind address (127.0.0.1)
 *   REF_PORTAL_PORT     customer portal "MyCover" (4700)
 *   REF_BACKOFFICE_PORT back-office "ClaimDesk" (4701)
 *   REF_API_PORT        REST + GraphQL + OAuth2 gateway (4702)
 *   REF_SOAP_PORT       legacy SOAP policy administration service (4703)
 *   REF_DB              SQLite file (var/larkspur.db)
 *   REF_DROP_DIR        folder the nightly batch drops CSV files into (var/drop)
 *   REF_KAFKA           Kafka bootstrap host:port, or "off" (127.0.0.1:19092)
 *   REF_SMTP            SMTP relay host:port for notifications, or "off" (127.0.0.1:2525)
 *   REF_BUG             deliberate defect: none | premium-tax | payout-deductible
 *   REF_VARIANT         UI variant: a | b (b renames the "Submit claim" button)
 *   REF_BATCH_DELAY_MS  how long the nightly batch "runs" (2500)
 *   REF_RESET           1 = delete the database and drop folder on start
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..');

const env = process.env;
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export type Bug = 'none' | 'premium-tax' | 'payout-deductible';

export const settings = {
  host: env.REF_HOST ?? '127.0.0.1',
  portalPort: num(env.REF_PORTAL_PORT, 4700),
  backofficePort: num(env.REF_BACKOFFICE_PORT, 4701),
  apiPort: num(env.REF_API_PORT, 4702),
  soapPort: num(env.REF_SOAP_PORT, 4703),
  dbFile: resolve(env.REF_DB ?? join(ROOT, 'var', 'larkspur.db')),
  dropDir: resolve(env.REF_DROP_DIR ?? join(ROOT, 'var', 'drop')),
  kafka: env.REF_KAFKA ?? '127.0.0.1:19092',
  smtp: env.REF_SMTP ?? '127.0.0.1:2525',
  bug: ((env.REF_BUG as Bug | undefined) ?? 'none') as Bug,
  variant: (env.REF_VARIANT === 'b' ? 'b' : 'a') as 'a' | 'b',
  batchDelayMs: num(env.REF_BATCH_DELAY_MS, 2500),
  reset: env.REF_RESET === '1',
};

export const urls = {
  portal: () => `http://${settings.host}:${settings.portalPort}`,
  backoffice: () => `http://${settings.host}:${settings.backofficePort}`,
  api: () => `http://${settings.host}:${settings.apiPort}`,
  soap: () => `http://${settings.host}:${settings.soapPort}`,
};

/** Insurance premium tax rate applied to the net premium. */
export const PREMIUM_TAX_RATE = 0.12;
/** An adjuster may approve up to this amount; above it the claim is referred to a senior adjuster. */
export const ADJUSTER_LIMIT = 10_000;
