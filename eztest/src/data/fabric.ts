/**
 * Test Data Fabric: resolves a journey's DataNeeds through providers
 * (find / create / generate), leases what it finds so parallel journeys never
 * share a record, and removes everything it created when the run ends.
 */
import { join } from 'node:path';
import { DataNeed, EzTestError, silentLogger, type Logger } from '../core/index.js';
import type { z } from 'zod';
import { CleanupRegistry, sweepOrphans, type CleanupJournal, type CleanupReport, type SweepOptions, type SweepReport } from './cleanup.js';
import { describeConstraints, matchesAll, parseWhere, type Constraint } from './constraints.js';
import { LeaseRegistry, type Lease } from './lease.js';
import type { DataProvider, DataRecord } from './providers.js';

export type DataNeedInput = z.input<typeof DataNeed>;

export interface ResolvedData {
  as: string;
  entity: string;
  record: DataRecord;
  source: 'found' | 'created' | 'generated';
  provider: string;
  lease?: Lease;
}

export interface DataFabricOptions {
  providers?: DataProvider[];
  /** Shared lease registry (default: .eztest/leases under cwd). */
  leases?: LeaseRegistry;
  logger?: Logger;
  /** How many candidates to consider per find (default 25). */
  findLimit?: number;
  mask?: (s: string) => string;
  /** Durable journal of created records: survives crashes so the next run's orphan sweep can delete them. */
  journal?: CleanupJournal;
}

export interface ReleaseReport extends CleanupReport {
  leasesReleased: number;
}

export class DataFabric {
  readonly leases: LeaseRegistry;
  readonly cleanup = new CleanupRegistry();
  private readonly providers: DataProvider[] = [];
  private readonly logger: Logger;
  private readonly resolved: ResolvedData[] = [];

  constructor(private readonly o: DataFabricOptions = {}) {
    for (const p of o.providers ?? []) this.register(p);
    this.leases = o.leases ?? new LeaseRegistry({ dir: join(process.cwd(), '.eztest', 'leases') });
    this.logger = o.logger ?? silentLogger;
  }

  register(p: DataProvider): this {
    this.providers.push(p);
    return this;
  }

  /** Everything resolved so far in this fabric (one fabric per run/worker). */
  get records(): ResolvedData[] {
    return [...this.resolved];
  }

  private candidates(entity: string, op: 'find' | 'create' | 'generate'): DataProvider[] {
    return this.providers.filter((p) => p.supports(entity) && typeof p[op] === 'function');
  }

  async resolve(input: DataNeedInput): Promise<ResolvedData> {
    const need = DataNeed.parse(input);
    const constraints = parseWhere(need.where);
    const supporting = this.providers.filter((p) => p.supports(need.entity));
    if (supporting.length === 0) throw new EzTestError(`No data provider handles entity "${need.entity}"`, 'DATA_NO_PROVIDER', { entity: need.entity });

    let r: ResolvedData | undefined;
    if (need.strategy === 'generate') r = await this.generate(need, constraints);
    else if (need.strategy === 'create') r = await this.create(need, constraints);
    else {
      r = await this.find(need, constraints);
      if (!r && need.strategy === 'find-or-create') r = await this.create(need, constraints);
      if (!r) {
        throw new EzTestError(`No available ${need.entity} where ${describeConstraints(constraints)} (all matches missing or leased)`, 'DATA_NOT_FOUND', {
          entity: need.entity,
        });
      }
    }
    this.resolved.push(r);
    this.logger.debug(`data: ${need.as} = ${need.entity} (${r.source} via ${r.provider})`);
    return r;
  }

  /** Resolve several needs; returns alias -> record. On failure, already-resolved data stays tracked for release(). */
  async resolveAll(needs: DataNeedInput[]): Promise<Record<string, DataRecord>> {
    const out: Record<string, DataRecord> = {};
    for (const n of needs) {
      const r = await this.resolve(n);
      if (r.as in out) throw new EzTestError(`Duplicate data alias "${r.as}"`, 'DATA_ALIAS');
      out[r.as] = r.record;
    }
    return out;
  }

  private async find(need: DataNeed, cs: Constraint[]): Promise<ResolvedData | undefined> {
    for (const p of this.candidates(need.entity, 'find')) {
      const rows = await p.find!(need.entity, cs, { limit: this.o.findLimit ?? 25 });
      for (const rec of rows) {
        if (!matchesAll(rec, cs)) {
          this.logger.warn(`data: ${p.name} returned a ${need.entity} that does not match ${describeConstraints(cs)}; skipped`);
          continue;
        }
        const lease = await this.leases.tryAcquire(`${p.name}:${need.entity}:${p.idOf(need.entity, rec)}`);
        if (lease) return { as: need.as, entity: need.entity, record: rec, source: 'found', provider: p.name, lease };
      }
    }
    return undefined;
  }

  private async create(need: DataNeed, cs: Constraint[]): Promise<ResolvedData> {
    const p = this.candidates(need.entity, 'create')[0];
    if (!p) throw new EzTestError(`No data provider can create "${need.entity}"`, 'DATA_NO_PROVIDER', { entity: need.entity });
    const rec = await p.create!(need.entity, {}, cs);
    const id = p.idOf(need.entity, rec);
    const label = `${p.name}:${need.entity}:${id}`;
    // Journal first: if the process dies from here on, the next run deletes this record.
    const jid = p.delete && this.o.journal ? await this.o.journal.record({ provider: p.name, entity: need.entity, recordId: String(id), record: rec }) : undefined;
    if (p.delete) {
      this.cleanup.add(`delete ${label}`, async () => {
        await p.delete!(need.entity, rec);
        if (jid) await this.o.journal!.done(jid);
      });
    }
    else this.logger.warn(`data: ${p.name} cannot delete ${need.entity}; created record ${id} will remain`);
    if (!matchesAll(rec, cs)) throw new EzTestError(`Created ${need.entity} ${id} does not satisfy ${describeConstraints(cs)}`, 'DATA_CREATE');
    const lease = await this.leases.tryAcquire(label);
    if (!lease) throw new EzTestError(`Created ${need.entity} ${id} was leased by another worker first`, 'DATA_LEASE_CONFLICT');
    return { as: need.as, entity: need.entity, record: rec, source: 'created', provider: p.name, lease };
  }

  private async generate(need: DataNeed, cs: Constraint[]): Promise<ResolvedData> {
    const p = this.candidates(need.entity, 'generate')[0];
    if (!p) throw new EzTestError(`No data provider can generate "${need.entity}"`, 'DATA_NO_PROVIDER', { entity: need.entity });
    const rec = await p.generate!(need.entity, cs);
    return { as: need.as, entity: need.entity, record: rec, source: 'generated', provider: p.name };
  }

  /** Remove created data (reverse order) and release all leases. Safe to call more than once. */
  async release(): Promise<ReleaseReport> {
    const report = await this.cleanup.runAll(this.o.mask);
    let leasesReleased = 0;
    for (const r of this.resolved) {
      if (r.lease && (await this.leases.release(r.lease))) leasesReleased++;
    }
    leasesReleased += await this.leases.releaseAll();
    this.resolved.length = 0;
    for (const f of report.failures) this.logger.warn(`data cleanup failed: ${f.description}: ${f.error}`);
    return { ...report, leasesReleased };
  }

  /** Delete records that crashed runs created and never removed (their cleanup journals in `dir`). */
  async sweepOrphans(dir: string, o: SweepOptions = {}): Promise<SweepReport> {
    const report = await sweepOrphans(dir, async (e) => {
      const p = this.providers.find((x) => x.name === e.provider && x.supports(e.entity) && typeof x.delete === 'function');
      if (!p) return false;
      await p.delete!(e.entity, e.record as DataRecord);
      return true;
    }, o);
    for (const r of report.removed) this.logger.info(`data: removed orphaned ${r.entity} ${r.recordId} (${r.provider}) left by a crashed run`);
    for (const f of report.failed) this.logger.warn(`data: could not remove orphaned ${f.entity} ${f.recordId}: ${f.error}`);
    return report;
  }

  /** Resolve, run, and always clean up (even when fn throws). */
  async withData<T>(needs: DataNeedInput[], fn: (data: Record<string, DataRecord>) => Promise<T>): Promise<T> {
    try {
      const data = await this.resolveAll(needs);
      return await fn(data);
    } finally {
      await this.release();
    }
  }
}
