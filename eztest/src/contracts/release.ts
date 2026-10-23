/**
 * Release safety for EZTest contracts: may version V of an application be
 * released to an environment? The EZTest results server keeps the published
 * contracts (per consumer version and branch), the verification results
 * (per provider version, against a contract's content hash) and what is
 * released where; `evaluateCanRelease` answers from those records:
 *
 * - as a consumer: every contract app@V published must have been verified,
 *   and passed, by the provider version released in that environment;
 * - as a provider: every consumer released in that environment whose
 *   contract names app must have been verified, and passed, by app@V.
 *
 * Unknown is never yes: a provider with nothing released in the environment,
 * or a contract nobody verified, blocks the release with that reason.
 */
export interface PublishedContract {
  consumer: string;
  provider: string;
  consumerVersion: string;
  branch?: string;
  hash: string;
  publishedAt: string;
  publishedBy?: string;
  /** The contract document (file form, see model.ts). */
  contract?: Record<string, unknown>;
}

export interface VerificationRecord {
  consumer: string;
  provider: string;
  /** Content hash of the verified contract. */
  hash: string;
  consumerVersion?: string;
  providerVersion: string;
  providerBranch?: string;
  passed: boolean;
  failed?: string[];
  verifiedAt: string;
  verifiedBy?: string;
}

export interface ReleaseRecord {
  app: string;
  environment: string;
  version: string;
  releasedAt: string;
  releasedBy?: string;
}

export interface ReleaseCheck {
  consumer: string;
  consumerVersion: string;
  provider: string;
  providerVersion?: string;
  ok: boolean;
  reason: string;
}

export interface CanReleaseResult {
  app: string;
  version: string;
  environment: string;
  releasable: boolean;
  reason: string;
  checks: ReleaseCheck[];
}

export interface CanReleaseInput {
  app: string;
  version: string;
  environment: string;
  contracts: PublishedContract[];
  verifications: VerificationRecord[];
  releases: ReleaseRecord[];
}

function check(c: PublishedContract, providerVersion: string | undefined, verifications: VerificationRecord[], environment: string): ReleaseCheck {
  const base = { consumer: c.consumer, consumerVersion: c.consumerVersion, provider: c.provider, ...(providerVersion ? { providerVersion } : {}) };
  if (!providerVersion) return { ...base, ok: false, reason: `${c.provider} has no version released to ${environment}` };
  const runs = verifications.filter((v) => v.provider === c.provider && v.providerVersion === providerVersion && v.hash === c.hash);
  if (!runs.length) return { ...base, ok: false, reason: `${c.provider} ${providerVersion} has not verified the contract of ${c.consumer} ${c.consumerVersion}` };
  const latest = runs.reduce((a, b) => (Date.parse(b.verifiedAt) > Date.parse(a.verifiedAt) ? b : a));
  return latest.passed
    ? { ...base, ok: true, reason: `${c.provider} ${providerVersion} verified the contract of ${c.consumer} ${c.consumerVersion}` }
    : { ...base, ok: false, reason: `${c.provider} ${providerVersion} failed the contract of ${c.consumer} ${c.consumerVersion}${latest.failed?.length ? ` (${latest.failed.slice(0, 3).join('; ')})` : ''}` };
}

export function evaluateCanRelease(i: CanReleaseInput): CanReleaseResult {
  const released = (app: string) => i.releases.find((r) => r.app === app && r.environment === i.environment)?.version;
  const checks: ReleaseCheck[] = [];
  // As a consumer: the contracts this version published.
  for (const c of i.contracts.filter((x) => x.consumer === i.app && x.consumerVersion === i.version)) {
    checks.push(check(c, released(c.provider), i.verifications, i.environment));
  }
  // As a provider: the contracts of the consumers released in the environment.
  for (const r of i.releases.filter((x) => x.environment === i.environment && x.app !== i.app)) {
    const c = i.contracts.find((x) => x.consumer === r.app && x.consumerVersion === r.version && x.provider === i.app);
    if (c) checks.push(check(c, i.version, i.verifications, i.environment));
  }
  const failed = checks.filter((c) => !c.ok);
  const releasable = failed.length === 0;
  const reason = !checks.length
    ? `no contract involves ${i.app} ${i.version} in ${i.environment}`
    : releasable
      ? `all ${checks.length} contract check(s) passed`
      : `${failed.length} of ${checks.length} contract check(s) failed: ${failed.map((f) => f.reason).join('; ')}`;
  return { app: i.app, version: i.version, environment: i.environment, releasable, reason, checks };
}

export function canReleaseText(r: CanReleaseResult): string {
  const lines = [`${r.releasable ? 'YES' : 'NO'}: ${r.app} ${r.version} to ${r.environment} - ${r.reason}`];
  for (const c of r.checks) lines.push(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.consumer} ${c.consumerVersion} -> ${c.provider} ${c.providerVersion ?? '(none released)'}: ${c.reason}`);
  return lines.join('\n');
}
