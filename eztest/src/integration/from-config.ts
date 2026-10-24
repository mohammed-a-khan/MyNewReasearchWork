/**
 * Build the integration runtime, the contract recorder and the API contract hook
 * from a loaded configuration. Secret references (secret://store/key, ENC())
 * in broker, SFTP/SSH, gRPC and broker settings are resolved here and every
 * resolved value is added to the masker.
 */
import { isAbsolute, resolve } from 'node:path';
import type { EzTestConfig } from '../config/index.js';
import { ContractRecorder } from '../contracts/consumer.js';
import { apiSpecEntries } from '../contracts/config.js';
import { createContractHook } from '../contracts/hook.js';
import { cachedSpec } from '../contracts/openapi.js';
import type { ApiExchangeHook, StepContext } from '../runner/types.js';
import { createIntegrationRuntime, type Integration } from './runtime.js';

export interface IntegrationFromConfig {
  runtime: Integration;
  contracts: ContractRecorder;
  apiHook?: ApiExchangeHook;
  /** api.spec entries with absolute files (a baseUrl scopes a spec to the calls to that service). */
  specEntries: Array<{ file: string; baseUrl?: string }>;
  /** Absolute api.spec paths. */
  specs: string[];
}

type Secretish = Record<string, unknown>;

const SECRET_KEYS = new Set(['password', 'passphrase', 'token', 'privateKey', 'sharedAccessKey', 'clientSecret', 'secretAccessKey', 'sessionToken', 'accessKeyId']);

/** Resolve secret references in the given keys of a nested object (copy). */
async function resolveSecrets<T>(v: T, resolveSecret: (ref: string) => Promise<string>, mask: (s: string) => void, all = false): Promise<T> {
  if (Array.isArray(v)) return (await Promise.all(v.map((x) => resolveSecrets(x, resolveSecret, mask, all)))) as T;
  if (!v || typeof v !== 'object') return v;
  const out: Secretish = {};
  for (const [k, x] of Object.entries(v as Secretish)) {
    if (typeof x === 'string' && (all || SECRET_KEYS.has(k)) && (x.startsWith('secret://') || /^ENC\(/.test(x))) {
      const s = await resolveSecret(x);
      mask(s);
      out[k] = s;
    } else if (typeof x === 'string' && SECRET_KEYS.has(k) && k !== 'privateKey') {
      // Literal secrets in config still never reach logs or evidence.
      mask(x);
      out[k] = x;
    } else out[k] = typeof x === 'object' ? await resolveSecrets(x, resolveSecret, mask, all || k === 'metadata') : x;
  }
  return out as T;
}

export async function integrationFromConfig(
  config: EzTestConfig,
  o: {
    cwd: string;
    resolveSecret: (ref: string) => Promise<string>;
    masker: { add(v: string): unknown; mask(s: string): string };
    apiAuth?: (role: string, ctx: StepContext) => Promise<Record<string, string>>;
    templateSyntax?: 'dollar' | 'mustache';
  },
): Promise<IntegrationFromConfig> {
  const add = (s: string) => {
    if (s) o.masker.add(s);
  };
  const messaging = config.messaging ? await resolveSecrets(config.messaging, o.resolveSecret, add) : undefined;
  const files = config.files ? await resolveSecrets(config.files, o.resolveSecret, add) : undefined;
  const grpc = config.grpc ? await resolveSecrets(config.grpc, o.resolveSecret, add) : undefined;
  const specEntries = apiSpecEntries(config.api.spec).map((e) => ({ ...e, file: isAbsolute(e.file) ? e.file : resolve(o.cwd, e.file) }));
  const specs = specEntries.map((e) => e.file);
  // Load specs now so a broken spec fails the run up front, not halfway.
  for (const s of specs) cachedSpec(s);
  const contracts = config.contracts;
  const recorder = new ContractRecorder({
    baseDir: o.cwd,
    defaultDir: contracts?.dir ?? 'contracts',
    matchers: contracts?.matchers ?? 'type',
    spec: () => (specs[0] ? cachedSpec(specs[0]) : undefined),
    mask: (s) => o.masker.mask(s),
  });
  const runtime = createIntegrationRuntime({
    baseDir: o.cwd,
    ...(messaging ? { messaging } : {}),
    ...(grpc ? { grpc } : {}),
    ...(files ? { files } : {}),
    ...(config.batch ? { batch: config.batch } : {}),
    contracts: recorder,
    ...(o.apiAuth ? { apiAuth: o.apiAuth } : {}),
    ...(o.templateSyntax ? { templateSyntax: o.templateSyntax } : {}),
  });
  const apiHook = createContractHook({ specs: specEntries, mode: config.api.specMode, strictPaths: config.api.specStrict, recorder });
  return { runtime, contracts: recorder, ...(apiHook ? { apiHook } : {}), specs, specEntries };
}
