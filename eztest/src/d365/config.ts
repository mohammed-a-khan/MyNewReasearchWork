/**
 * `d365:` configuration and one-call wiring: a DataverseClient (OAuth2 client
 * credentials), the intent rules and the custom step handlers.
 */
import { z } from 'zod';
import { EzTestError } from '../core/index.js';
import { OAuth2TokenProvider } from '../identity/oauth.js';
import { registerIntentRules, type IntentRule } from '../intent/index.js';
import type { CustomStepHandler } from '../runner/types.js';
import type { TokenProvider } from '../surfaces/index.js';
import { DataverseClient } from './client.js';
import { createD365IntentRules } from './intents.js';
import { createD365Steps, type D365StepsOptions } from './steps.js';

export const D365ConfigSchema = z
  .object({
    /** Environment URL, e.g. https://contoso.crm.dynamics.com */
    url: z.string().url(),
    /** OAuth2 token endpoint; or give tenantId for Microsoft Entra ID. */
    tokenUrl: z.string().url().optional(),
    tenantId: z.string().regex(/^[A-Za-z0-9.-]+$/).optional(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    /** Default `<url>/.default`. */
    scope: z.string().optional(),
    apiVersion: z.string().regex(/^\d+\.\d+$/).default('9.2'),
    /** UCI root if different from url; model-driven app id. */
    appUrl: z.string().url().optional(),
    appId: z.string().optional(),
    /** Logical names to snapshot for release-wave impact (and to recognise in phrasings). */
    entities: z.array(z.string().min(1)).min(1),
    dateFormat: z.enum(['M/d/yyyy', 'd/M/yyyy', 'yyyy-MM-dd']).default('M/d/yyyy'),
    timeoutMs: z.number().int().positive().optional(),
  })
  .refine((c) => !!c.tokenUrl || !!c.tenantId, { message: 'd365 needs tokenUrl or tenantId' });
export type D365Config = z.infer<typeof D365ConfigSchema>;
export type D365ConfigInput = z.input<typeof D365ConfigSchema>;

export function parseD365Config(input: unknown): D365Config {
  const r = D365ConfigSchema.safeParse(input);
  if (!r.success) throw new EzTestError(`Invalid d365 config: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'D365_CONFIG');
  return r.data;
}

export function d365TokenProvider(cfg: D365Config, o: { fetch?: typeof fetch } = {}): TokenProvider {
  const root = cfg.url.replace(/\/+$/, '');
  return new OAuth2TokenProvider({
    tokenUrl: cfg.tokenUrl ?? `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    scope: cfg.scope ?? `${root}/.default`,
    fetch: o.fetch,
  });
}

export interface D365Integration {
  client: DataverseClient;
  intentRules: IntentRule[];
  customSteps: Record<string, CustomStepHandler>;
  /** Register the intent rules with the grammar; returns the unregister function. */
  registerIntents(): () => void;
}

/** Build everything the engine needs from a `d365:` config block. */
export function createD365Integration(
  input: D365ConfigInput | D365Config,
  o: { fetch?: typeof fetch; tokenProvider?: TokenProvider; steps?: Partial<D365StepsOptions>; entityNames?: string[] } = {},
): D365Integration {
  const cfg = parseD365Config(input);
  const client = new DataverseClient({
    url: cfg.url, apiVersion: cfg.apiVersion, tokenProvider: o.tokenProvider ?? d365TokenProvider(cfg, o), fetch: o.fetch, timeoutMs: cfg.timeoutMs,
  });
  const intentRules = createD365IntentRules({ entities: o.entityNames });
  const customSteps = createD365Steps({
    metadata: client, client, appUrl: cfg.appUrl ?? cfg.url, appId: cfg.appId, dateFormat: cfg.dateFormat, timeoutMs: cfg.timeoutMs, ...o.steps,
  });
  return { client, intentRules, customSteps, registerIntents: () => registerIntentRules(intentRules) };
}
