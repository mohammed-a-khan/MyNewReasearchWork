/**
 * `eztest queries list|check` and the database part of `eztest doctor`.
 */
import type { Command } from 'commander';
import type { LoadedConfig } from '../config/index.js';
import type { Journey } from '../core/index.js';
import { dbRegistryFromConfig } from '../engine/index.js';
import { identityVaultFromConfig } from '../identity/index.js';
import { QueryCatalogue, checkQueries, queryRefs, validateQueryRefs } from '../queries/index.js';
import { checkDbHealth, type SqlDialect } from '../surfaces/index.js';

interface IO {
  out(s: string): void;
  err(s: string): void;
  cwd: string;
}

type Load = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;

function pad(s: string, n: number): string {
  return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length);
}

export function registerQueryCommands(program: Command, io: IO, load: Load): void {
  const queries = program.command('queries').description('the named-query catalogue (db.queries)');
  queries
    .command('list')
    .description('list catalogue queries with their connection and params')
    .option('-c, --config <file>')
    .option('-e, --env <name>')
    .option('--project <name>', 'project overlay (projects.<name>)')
    .option('--connection <alias>', 'only queries on this connection')
    .option('--fragments', 'include fragments')
    .option('--json', 'machine-readable output')
    .action(async (o: { config?: string; env?: string; connection?: string; fragments?: boolean; json?: boolean }) => {
      const loaded = await load(o);
      const cat = await QueryCatalogue.fromConfig(loaded.config.db.queries, io.cwd);
      const rows = cat
        .all()
        .filter((q) => o.fragments || !q.fragment)
        .filter((q) => !o.connection || q.connection === o.connection)
        .map((q) => ({ name: q.name, connection: q.connection ?? '', params: cat.paramsOf(q.name).map((p) => (p.default !== undefined ? `${p.name}=${JSON.stringify(p.default)}` : p.name)), description: q.description ?? '', fragment: q.fragment, source: q.source }));
      if (o.json) {
        io.out(JSON.stringify(rows, null, 2));
        return;
      }
      if (!rows.length) {
        io.out(`No queries (looked in ${loaded.config.db.queries.dir}/ and db.queries.inline).`);
        return;
      }
      const w = Math.max(...rows.map((r) => r.name.length)) + 2;
      const cw = Math.max(12, ...rows.map((r) => r.connection.length + 2));
      for (const r of rows) io.out(`${pad(r.name, w)}${pad(r.connection || '-', cw)}${r.fragment ? '(fragment) ' : ''}${r.params.length ? `(${r.params.join(', ')}) ` : ''}${r.description}`);
      io.out(`${rows.length} quer${rows.length === 1 ? 'y' : 'ies'}`);
    });
  queries
    .command('check')
    .description('prepare/describe every query against the live database without executing writes')
    .argument('[names...]', 'only these queries')
    .option('-c, --config <file>')
    .option('-e, --env <name>')
    .option('--project <name>', 'project overlay (projects.<name>)')
    .option('--connection <alias>', 'only queries on this connection (also used for queries without a connection header)')
    .option('--json', 'machine-readable output')
    .action(async (names: string[], o: { config?: string; env?: string; connection?: string; json?: boolean }) => {
      const loaded = await load(o);
      let cat: QueryCatalogue;
      try {
        cat = await QueryCatalogue.fromConfig(loaded.config.db.queries, io.cwd);
      } catch (e) {
        io.err(`error  ${(e as Error).message}`);
        process.exitCode = 1;
        return;
      }
      const vault = identityVaultFromConfig(loaded.config, { cwd: io.cwd, masker: loaded.masker });
      const dbs = dbRegistryFromConfig(loaded.config, vault);
      const only = Object.keys(loaded.config.db.connections);
      try {
        const results = await checkQueries(cat, { connection: o.connection, defaultConnection: only.length === 1 ? only[0] : undefined, names, open: (n) => dbs.get(n) });
        const masked = results.map((r) => ({ ...r, message: r.message ? loaded.masker.mask(r.message) : undefined }));
        if (o.json) io.out(JSON.stringify(masked, null, 2));
        else {
          for (const r of masked) {
            const tag = r.status === 'ok' ? 'ok   ' : r.status === 'error' ? 'ERROR' : 'skip ';
            const line = `${tag}  ${r.name}${r.connection ? ` on ${r.connection}` : ''}: ${r.status === 'ok' ? r.method : r.message ?? r.method}`;
            if (r.status === 'error') io.err(line);
            else io.out(line);
          }
          const bad = masked.filter((r) => r.status === 'error').length;
          io.out(`${masked.length} checked: ${masked.filter((r) => r.status === 'ok').length} ok, ${bad} error(s), ${masked.filter((r) => r.status === 'skipped').length} skipped`);
        }
        process.exitCode = results.some((r) => r.status === 'error') ? 1 : 0;
      } finally {
        await dbs.closeAll().catch(() => undefined);
      }
    });
}

/** `eztest doctor`: connect to every configured database and load the catalogue. Returns false on any failure. */
export async function doctorDatabases(loaded: LoadedConfig, io: IO): Promise<boolean> {
  let ok = true;
  const conns = loaded.config.db.connections;
  const names = Object.keys(conns);
  if (names.length) {
    const vault = identityVaultFromConfig(loaded.config, { cwd: io.cwd, masker: loaded.masker });
    const dbs = dbRegistryFromConfig(loaded.config, vault);
    try {
      for (const n of names) {
        const h = await checkDbHealth(n, () => dbs.get(n), conns[n].driver as SqlDialect);
        if (h.ok) io.out(`db ${pad(n, 9)}${h.dialect} ok (${h.latencyMs} ms)${h.version ? ` ${loaded.masker.mask(h.version).slice(0, 80)}` : ''}${h.detail ? ` [${h.detail}]` : ''}`);
        else {
          ok = false;
          io.out(`db ${pad(n, 9)}${h.dialect} ERROR ${loaded.masker.mask(h.error ?? '')}`);
        }
      }
    } finally {
      await dbs.closeAll().catch(() => undefined);
    }
  }
  try {
    const cat = await QueryCatalogue.fromConfig(loaded.config.db.queries, io.cwd);
    const all = cat.all();
    if (all.length) io.out(`queries     ${all.filter((q) => !q.fragment).length} queries, ${all.filter((q) => q.fragment).length} fragments`);
  } catch (e) {
    ok = false;
    io.out(`queries     ERROR ${(e as Error).message}`);
  }
  return ok;
}

/** Catalogue problems of loaded journeys, for `eztest validate`. */
export async function validateJourneyQueries(journeys: Array<{ file: string; journey: Journey }>, loaded: LoadedConfig | undefined, cwd: string): Promise<Array<{ file: string; message: string }>> {
  const using = journeys.filter((j) => queryRefs(j.journey).length);
  if (!using.length) return [];
  let cat: QueryCatalogue;
  try {
    cat = await QueryCatalogue.fromConfig(loaded?.config.db.queries, cwd);
  } catch (e) {
    return [{ file: 'db.queries', message: (e as Error).message }];
  }
  const out: Array<{ file: string; message: string }> = [];
  for (const j of using) {
    const problems = validateQueryRefs(j.journey, cat, loaded ? Object.keys(loaded.config.db.connections) : []);
    // Without a config file connections cannot be checked; report only catalogue problems then.
    for (const p of problems) if (loaded || !/unknown connection/.test(p)) out.push({ file: j.file, message: p });
  }
  return out;
}
