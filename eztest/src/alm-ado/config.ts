/**
 * An AdoClient from the project configuration (`ado.*`) and the environment:
 * dev.azure.com or an Azure DevOps Server collection URL, its api-version,
 * and credentials resolved by resolveAdoAuth. In Azure Pipelines the
 * collection URL and project default to System.CollectionUri and
 * System.TeamProject.
 */
import type { EzTestConfig, SecretMasker } from '../config/index.js';
import { EzTestError, type Logger } from '../core/index.js';
import { resolveAdoAuth } from './auth.js';
import { AdoClient } from './client.js';

export interface AdoFromConfigOptions {
  env?: Record<string, string | undefined>;
  resolveSecret?: (ref: string) => Promise<string>;
  masker?: SecretMasker;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface AdoSettings {
  collectionUrl?: string;
  project?: string;
  missing: string[];
}

/** Where the client would point (and what is missing), without resolving credentials. */
export function adoSettings(config: Pick<EzTestConfig, 'ado'>, env: Record<string, string | undefined> = process.env): AdoSettings {
  const collectionUrl = config.ado.organizationUrl ?? env.SYSTEM_COLLECTIONURI ?? env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
  const project = config.ado.project ?? env.SYSTEM_TEAMPROJECT;
  const missing = [...(collectionUrl ? [] : ['ado.organizationUrl']), ...(project ? [] : ['ado.project'])];
  return { collectionUrl, project, missing };
}

export function hasAdoCredentials(config: Pick<EzTestConfig, 'ado'>, env: Record<string, string | undefined> = process.env): boolean {
  const a = config.ado.auth;
  if (config.ado.pat || env.SYSTEM_ACCESSTOKEN || env.EZTEST_ADO_PAT) return true;
  if (a.type === 'managed-identity') return true;
  return !!((a.tenantId ?? env.AZURE_TENANT_ID) && (a.clientId ?? env.AZURE_CLIENT_ID) && (a.clientSecret || a.serviceConnectionId || a.federatedTokenFile || env.AZURE_FEDERATED_TOKEN_FILE || env.AZURE_CLIENT_SECRET || env.ACTIONS_ID_TOKEN_REQUEST_URL));
}

export async function adoClientFromConfig(config: Pick<EzTestConfig, 'ado'>, o: AdoFromConfigOptions = {}): Promise<AdoClient> {
  const env = o.env ?? process.env;
  const s = adoSettings(config, env);
  if (s.missing.length) throw new EzTestError(`Azure DevOps is not configured: set ${s.missing.join(' and ')}`, 'ADO_CONFIG');
  const auth = await resolveAdoAuth({ ...config.ado.auth, pat: config.ado.pat }, { env, resolveSecret: o.resolveSecret, fetchImpl: o.fetchImpl });
  if (auth.type !== 'provider') o.masker?.add(auth.token);
  return new AdoClient({
    baseUrl: s.collectionUrl,
    project: s.project!,
    auth,
    apiVersion: config.ado.apiVersion,
    logger: o.logger,
    onSecret: (t) => o.masker?.add(t),
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
  });
}
