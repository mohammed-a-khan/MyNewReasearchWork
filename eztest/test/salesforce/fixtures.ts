/** Shared helpers for Salesforce adapter tests (mock server + REST clients + runner wiring). */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Journey, RunResult } from '../../src/core/index.js';
import { runJourneys } from '../../src/runner/index.js';
import {
  SalesforceClient, SalesforceTokenProvider, createSalesforceSteps, type SalesforceCredentialsProvider, type SalesforceStepsOptions,
} from '../../src/salesforce/index.js';
import type { SalesforceMockServer } from '../../examples/salesforce-mock/server.js';

export type Role = 'admin' | 'rep';

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `eztest-sf-${prefix}-`));
}

/** client_credentials (integration user) when no role is given, else the password flow as that role. */
export function tokenProviderFor(s: SalesforceMockServer, role?: Role, secret = s.clientSecret): SalesforceTokenProvider {
  if (!role) return new SalesforceTokenProvider({ tokenUrl: s.tokenUrl, clientId: s.clientId, clientSecret: secret, grant: 'client_credentials' });
  const u = s.users[role];
  // Password supplied lazily, like an Identity Vault secret handle.
  return new SalesforceTokenProvider({ tokenUrl: s.tokenUrl, clientId: s.clientId, clientSecret: secret, grant: 'password', username: u.username, password: async () => u.password });
}

export function clientFor(s: SalesforceMockServer, role?: Role): SalesforceClient {
  return new SalesforceClient({ instanceUrl: s.url, apiVersion: s.apiVersion, tokenProvider: tokenProviderFor(s, role), retry: false });
}

/** Identity-Vault-style credentials provider: passwords are resolver functions, never plain config. */
export function credentialsFor(s: SalesforceMockServer): SalesforceCredentialsProvider {
  return async (role) => {
    const u = s.users[role as Role];
    if (!u) throw new Error(`unknown role ${role}`);
    return { username: u.username, password: async () => u.password };
  };
}

export function stepsFor(s: SalesforceMockServer, extra: Partial<SalesforceStepsOptions> = {}) {
  const client = clientFor(s);
  const perRole = new Map<string, SalesforceClient>();
  return createSalesforceSteps({
    metadata: client,
    client,
    credentials: credentialsFor(s),
    userClient: (role) => {
      if (role !== 'admin' && role !== 'rep') return undefined;
      let c = perRole.get(role);
      if (!c) perRole.set(role, (c = clientFor(s, role)));
      return c;
    },
    timeoutMs: 8000,
    ...extra,
  });
}

export async function runSf(s: SalesforceMockServer, journeys: Journey[], extra: Partial<SalesforceStepsOptions> = {}, outputDir?: string): Promise<RunResult> {
  return runJourneys(journeys, {
    baseUrl: s.url,
    outputDir: outputDir ?? (await tempDir('run')),
    stepTimeoutMs: 8000,
    locateTimeoutMs: 2000,
    conditionTimeoutMs: 3000,
    customSteps: stepsFor(s, extra),
  });
}

/** "stepId:status:error" lines, for readable assertion failures. */
export function stepLines(run: RunResult, i = 0): string[] {
  return run.journeys[i].steps.map((s) => `${s.stepId}:${s.status}${s.error ? `:${s.error.message}` : ''}`);
}

/** A date N days from today (YYYY-MM-DD). */
export function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}
