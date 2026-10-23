/** Shared helpers for D365 adapter tests (mock server + Dataverse client + runner wiring). */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Journey, RunResult } from '../../src/core/index.js';
import { OAuth2TokenProvider } from '../../src/identity/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { DataverseClient, createD365Steps, type D365StepsOptions } from '../../src/d365/index.js';
import type { D365MockServer } from '../../examples/d365-mock/server.js';

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `eztest-d365-${prefix}-`));
}

export function tokenProviderFor(s: D365MockServer, secret = s.clientSecret): OAuth2TokenProvider {
  return new OAuth2TokenProvider({ tokenUrl: s.tokenUrl, clientId: s.clientId, clientSecret: secret, scope: `${s.url}/.default` });
}

export function clientFor(s: D365MockServer): DataverseClient {
  return new DataverseClient({ url: s.url, tokenProvider: tokenProviderFor(s), retry: false });
}

export async function runD365(s: D365MockServer, journeys: Journey[], client = clientFor(s), extra: Partial<D365StepsOptions> = {}): Promise<RunResult> {
  return runJourneys(journeys, {
    baseUrl: s.url,
    outputDir: await tempDir('run'),
    stepTimeoutMs: 8000,
    locateTimeoutMs: 2000,
    conditionTimeoutMs: 3000,
    customSteps: createD365Steps({ metadata: client, timeoutMs: 8000, ...extra }),
  });
}

/** "stepId:status:error" lines, for readable assertion failures. */
export function stepLines(run: RunResult, i = 0): string[] {
  return run.journeys[i].steps.map((s) => `${s.stepId}:${s.status}${s.error ? `:${s.error.message}` : ''}`);
}
