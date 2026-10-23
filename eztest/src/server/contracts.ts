/**
 * EZTest contracts on the results server: published contracts (per consumer
 * version, with the branch they came from), provider verification results
 * (per provider version, against a contract's content hash), what version
 * of each application is released to each environment, and the
 * can-release answer computed from those records. Every write is audited.
 */
import { contractHash, contractToJson, parseContract, type Contract } from '../contracts/model.js';
import { evaluateCanRelease, type CanReleaseResult, type PublishedContract, type ReleaseRecord, type VerificationRecord } from '../contracts/release.js';
import type { AuditLog } from './audit.js';
import type { Principal } from './auth.js';
import { ServiceError, checkName } from './service.js';
import { num, optStr, type Store } from './store.js';

const VERSION = /^[\w.+@:-]{1,200}$/;
function checkVersion(kind: string, v: unknown): string {
  if (typeof v !== 'string' || !VERSION.test(v)) throw new ServiceError(400, `Invalid ${kind} "${String(v).slice(0, 60)}" (letters, digits and . + @ : _ -)`);
  return v;
}
const optName = (kind: string, v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : checkName(kind, String(v)));

function contractFromRow(r: Record<string, unknown>, withContract: boolean): PublishedContract {
  return {
    consumer: String(r.consumer), provider: String(r.provider), consumerVersion: String(r.consumer_version), ...(optStr(r.branch) ? { branch: optStr(r.branch) } : {}),
    hash: String(r.hash), publishedAt: String(r.published_at ?? ''), ...(optStr(r.published_by) ? { publishedBy: optStr(r.published_by) } : {}),
    ...(withContract && r.data ? { contract: JSON.parse(String(r.data)) as Record<string, unknown> } : {}),
  };
}

function verificationFromRow(r: Record<string, unknown>): VerificationRecord {
  const data = r.data ? (JSON.parse(String(r.data)) as { failed?: string[] }) : {};
  return {
    consumer: String(r.consumer ?? ''), provider: String(r.provider), hash: String(r.hash), ...(optStr(r.consumer_version) ? { consumerVersion: optStr(r.consumer_version) } : {}),
    providerVersion: String(r.provider_version), ...(optStr(r.provider_branch) ? { providerBranch: optStr(r.provider_branch) } : {}), passed: num(r.passed) === 1,
    ...(data.failed?.length ? { failed: data.failed } : {}), verifiedAt: String(r.verified_at ?? ''), ...(optStr(r.verified_by) ? { verifiedBy: optStr(r.verified_by) } : {}),
  };
}

const releaseFromRow = (r: Record<string, unknown>): ReleaseRecord => ({
  app: String(r.app), environment: String(r.environment), version: String(r.version), releasedAt: String(r.released_at ?? ''), ...(optStr(r.released_by) ? { releasedBy: optStr(r.released_by) } : {}),
});

export interface ContractQuery {
  provider?: string;
  consumer?: string;
  /** Latest contract per consumer (and provider) on this branch. */
  branch?: string;
  /** Contracts of the consumer versions released to this environment. */
  environment?: string;
  /** Include the contract documents (default true). */
  withContracts?: boolean;
}

export class ContractRegistry {
  constructor(private readonly store: Store, private readonly audit: AuditLog, private readonly ensureProject: (p: string) => Promise<void>) {}

  /** Publish a contract for a consumer version. Republishing the same content is a no-op; different content for a published version is refused. */
  async publish(project: string, body: { contract?: unknown; version?: unknown; branch?: unknown }, who: Principal): Promise<PublishedContract & { created: boolean }> {
    let contract: Contract;
    try {
      contract = parseContract(body.contract, 'contract');
    } catch (e) {
      throw new ServiceError(400, (e as Error).message);
    }
    checkName('consumer', contract.consumer);
    checkName('provider', contract.provider);
    const version = checkVersion('consumer version', body.version);
    const branch = optName('branch', body.branch);
    const hash = contractHash(contract);
    await this.ensureProject(project);
    const prev = await this.store.one('SELECT hash, branch, published_at, published_by FROM ez_contracts WHERE project = ? AND consumer = ? AND provider = ? AND consumer_version = ?', [project, contract.consumer, contract.provider, version]);
    if (prev) {
      if (String(prev.hash) !== hash) throw new ServiceError(409, `${contract.consumer} ${version} already published a different contract with ${contract.provider} (publish a new version)`);
      return { consumer: contract.consumer, provider: contract.provider, consumerVersion: version, ...(optStr(prev.branch) ? { branch: optStr(prev.branch) } : {}), hash, publishedAt: String(prev.published_at ?? ''), created: false };
    }
    const at = new Date().toISOString();
    await this.store.run('INSERT INTO ez_contracts (project, consumer, provider, consumer_version, branch, hash, data, published_at, published_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      project, contract.consumer, contract.provider, version, branch ?? null, hash, JSON.stringify(contractToJson(contract)), at, who.id,
    ]);
    await this.audit.append({ actor: who.id, action: 'contract.publish', project, target: `${contract.consumer}->${contract.provider}@${version}`, details: { hash, branch, expectations: contract.expectations.length } });
    return { consumer: contract.consumer, provider: contract.provider, consumerVersion: version, ...(branch ? { branch } : {}), hash, publishedAt: at, publishedBy: who.id, created: true };
  }

  /**
   * Contracts to verify or show. With a branch: the latest per consumer on it.
   * With an environment: those of the consumer versions released there.
   * With neither: the latest per consumer plus every released one. Duplicates
   * (same content) are listed once, under the newest consumer version.
   */
  async list(project: string, q: ContractQuery = {}): Promise<PublishedContract[]> {
    const where = ['project = ?'];
    const params: string[] = [project];
    if (q.provider) (where.push('provider = ?'), params.push(checkName('provider', q.provider)));
    if (q.consumer) (where.push('consumer = ?'), params.push(checkName('consumer', q.consumer)));
    const rows = (await this.store.all(`SELECT * FROM ez_contracts WHERE ${where.join(' AND ')} ORDER BY published_at DESC`, params)).map((r) => contractFromRow(r, q.withContracts !== false));
    const pick: PublishedContract[] = [];
    const latestPer = (list: PublishedContract[]) => {
      const seen = new Set<string>();
      for (const c of list) {
        const k = `${c.consumer}|${c.provider}`;
        if (!seen.has(k)) (seen.add(k), pick.push(c));
      }
    };
    const releasedIn = async (env?: string) => {
      const rel = env ? await this.store.all('SELECT * FROM ez_releases WHERE project = ? AND environment = ?', [project, env]) : await this.store.all('SELECT * FROM ez_releases WHERE project = ?', [project]);
      for (const r of rel) for (const c of rows.filter((x) => x.consumer === String(r.app) && x.consumerVersion === String(r.version))) pick.push(c);
    };
    if (q.branch) latestPer(rows.filter((c) => c.branch === q.branch));
    if (q.environment) await releasedIn(checkName('environment', q.environment));
    if (!q.branch && !q.environment) {
      latestPer(rows);
      await releasedIn();
    }
    const byHash = new Map<string, PublishedContract>();
    for (const c of pick) if (!byHash.has(`${c.provider}|${c.hash}`)) byHash.set(`${c.provider}|${c.hash}`, c);
    return [...byHash.values()];
  }

  async get(project: string, consumer: string, provider: string, version: string): Promise<PublishedContract | undefined> {
    const r = await this.store.one('SELECT * FROM ez_contracts WHERE project = ? AND consumer = ? AND provider = ? AND consumer_version = ?', [project, checkName('consumer', consumer), checkName('provider', provider), checkVersion('consumer version', version)]);
    return r ? contractFromRow(r, true) : undefined;
  }

  /** Record a provider version's verification of a contract (by hash; the consumer and its version are informational). */
  async recordVerification(project: string, body: Record<string, unknown>, who: Principal): Promise<VerificationRecord> {
    const provider = checkName('provider', String(body.provider ?? ''));
    const providerVersion = checkVersion('provider version', body.providerVersion);
    const hash = String(body.hash ?? '');
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ServiceError(400, '"hash" must be the contract hash (64 hex characters)');
    if (typeof body.passed !== 'boolean') throw new ServiceError(400, '"passed" must be true or false');
    const known = await this.store.one('SELECT consumer, consumer_version FROM ez_contracts WHERE project = ? AND provider = ? AND hash = ?', [project, provider, hash]);
    if (!known) throw new ServiceError(404, `No contract with ${provider} has hash ${hash.slice(0, 12)}... (publish the contract first)`);
    const failed = Array.isArray(body.failed) ? body.failed.map((f) => String(f).slice(0, 500)).slice(0, 50) : [];
    const rec: VerificationRecord = {
      consumer: String(known.consumer), provider, hash, consumerVersion: optStr(body.consumerVersion) ?? String(known.consumer_version), providerVersion,
      ...(optName('branch', body.branch) ? { providerBranch: optName('branch', body.branch) } : {}), passed: body.passed, ...(failed.length ? { failed } : {}),
      verifiedAt: new Date().toISOString(), verifiedBy: who.id,
    };
    await this.store.run('DELETE FROM ez_contract_verifications WHERE project = ? AND provider = ? AND provider_version = ? AND hash = ?', [project, provider, providerVersion, hash]);
    await this.store.run(
      'INSERT INTO ez_contract_verifications (project, provider, provider_version, hash, consumer, consumer_version, provider_branch, passed, data, verified_at, verified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [project, provider, providerVersion, hash, rec.consumer, rec.consumerVersion ?? null, rec.providerBranch ?? null, rec.passed ? 1 : 0, JSON.stringify({ failed }), rec.verifiedAt, who.id],
    );
    await this.audit.append({ actor: who.id, action: 'contract.verify', project, target: `${rec.consumer}->${provider}@${providerVersion}`, details: { hash, passed: rec.passed } });
    return rec;
  }

  async verifications(project: string, q: { provider?: string; providerVersion?: string } = {}): Promise<VerificationRecord[]> {
    const where = ['project = ?'];
    const params: string[] = [project];
    if (q.provider) (where.push('provider = ?'), params.push(checkName('provider', q.provider)));
    if (q.providerVersion) (where.push('provider_version = ?'), params.push(checkVersion('provider version', q.providerVersion)));
    return (await this.store.all(`SELECT * FROM ez_contract_verifications WHERE ${where.join(' AND ')} ORDER BY verified_at DESC`, params)).map(verificationFromRow);
  }

  /** Record that a version of an application is now released to an environment. */
  async recordRelease(project: string, body: Record<string, unknown>, who: Principal): Promise<ReleaseRecord> {
    const app = checkName('app', String(body.app ?? ''));
    const environment = checkName('environment', String(body.environment ?? ''));
    const version = checkVersion('version', body.version);
    await this.ensureProject(project);
    const rec: ReleaseRecord = { app, environment, version, releasedAt: new Date().toISOString(), releasedBy: who.id };
    await this.store.run('DELETE FROM ez_releases WHERE project = ? AND app = ? AND environment = ?', [project, app, environment]);
    await this.store.run('INSERT INTO ez_releases (project, app, environment, version, released_at, released_by) VALUES (?, ?, ?, ?, ?, ?)', [project, app, environment, version, rec.releasedAt, who.id]);
    await this.audit.append({ actor: who.id, action: 'contract.release', project, target: `${app}@${version}`, details: { environment } });
    return rec;
  }

  async releases(project: string): Promise<ReleaseRecord[]> {
    return (await this.store.all('SELECT * FROM ez_releases WHERE project = ? ORDER BY app, environment', [project])).map(releaseFromRow);
  }

  async canRelease(project: string, q: { app?: string | null; version?: string | null; environment?: string | null }): Promise<CanReleaseResult> {
    const app = checkName('app', String(q.app ?? ''));
    const version = checkVersion('version', q.version);
    const environment = checkName('environment', String(q.environment ?? ''));
    const contracts = (await this.store.all('SELECT * FROM ez_contracts WHERE project = ? AND (consumer = ? OR provider = ?)', [project, app, app])).map((r) => contractFromRow(r, false));
    const providers = [...new Set(contracts.map((c) => c.provider))];
    const verifications: VerificationRecord[] = [];
    for (const p of providers) verifications.push(...(await this.verifications(project, { provider: p })));
    return evaluateCanRelease({ app, version, environment, contracts, verifications, releases: await this.releases(project) });
  }
}
