/**
 * `eztest contracts ...` (spec lint, API coverage, EZTest contracts: publish
 * to the results server, verify a running provider, can-release,
 * record-release, contracts from mock recordings) and the spec- and
 * proto-driven mocks under `eztest mock`.
 */
import { Command, Option } from 'commander';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { LoadedConfig } from '../config/index.js';
import { createEngine, journeyFileResolver } from '../engine/index.js';
import {
  apiCoverageMarkdown, apiSpecEntries, canReleaseText, contractFileName, contractFromMockStore, contractHash, contractToJson, createOpenApiMock, isContractFile, lintReportText, lintSpec,
  loadApiSpec, messageProducersFromConfig, mockStoreFromSpec, parseContract, readContractFile, recordApiCoverage, recordContractResults, stateHandlersFromConfig, verificationText, verifyContract,
  type Contract, type ContractVerification, type LintSeverity,
} from '../contracts/index.js';
import { loadStore, saveStore } from '../mocks/index.js';
import { createGrpcMock } from '../integration/grpc.js';
import type { Integration } from '../integration/runtime.js';
import type { CliIO } from './program.js';
import { serverClientFor } from './scale.js';

type Loader = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;

function list(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

async function contractFiles(io: CliIO, paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    const abs = resolve(io.cwd, p);
    if (!existsSync(abs)) throw new Error(`No such contract file or directory: ${p}`);
    if (!statSync(abs).isDirectory()) out.push(abs);
    else out.push(...(await readdir(abs)).filter(isContractFile).sort().map((f) => join(abs, f)));
  }
  return out;
}

function waitForStop(seconds?: number): Promise<void> {
  return new Promise((r) => {
    if (seconds) setTimeout(r, seconds * 1000);
    process.once('SIGINT', () => r());
    process.once('SIGTERM', () => r());
  });
}

export function registerContractCommands(program: Command, io: CliIO, load: Loader): void {
  const withConfig = (c: Command) =>
    c.option('-c, --config <file>', 'config file').option('-e, --env <name>', 'environment name').option('--project <name>', 'project overlay');
  const contract = program.command('contracts').alias('contract').description('API contracts: OpenAPI lint and coverage; EZTest contracts: publish, verify, can-release (through the EZTest results server)');

  contract
    .command('lint')
    .description('check an OpenAPI/Swagger spec against governance rules (exit 1 on errors)')
    .argument('<spec>')
    .option('--rule <id=severity>', 'override a rule: id=off|error|warning|info (repeatable)', (v: string, prev: string[] = []) => [...prev, v])
    .option('--json', 'print JSON')
    .action(async (spec: string, o: { rule?: string[]; json?: boolean }) => {
      const rules = Object.fromEntries((o.rule ?? []).map((r) => r.split('=') as [string, LintSeverity | 'off']));
      const r = lintSpec(loadApiSpec(resolve(io.cwd, spec)), { rules });
      io.out(o.json ? JSON.stringify(r, null, 2) : lintReportText(r));
      process.exitCode = r.passed ? 0 : 1;
    });

  withConfig(contract.command('coverage'))
    .description('API coverage of a run against the spec (api.spec or --spec): operations, status codes, parameters')
    .argument('<runDir>')
    .option('--spec <files>', 'spec file(s), comma separated (default: api.spec)', list)
    .option('--min <ratio>', 'exit 1 when operation coverage is below this ratio', Number)
    .action(async (runDir: string, o: { spec?: string[]; min?: number; config?: string; env?: string; project?: string }) => {
      let specs: Array<string | { file: string; baseUrl?: string }> = (o.spec ?? []).map((s) => resolve(io.cwd, s));
      if (!specs.length) {
        const l = await load(o);
        specs = apiSpecEntries(l.config.api.spec).map((x) => ({ ...x, file: resolve(io.cwd, x.file) }));
      }
      if (!specs.length) throw new Error('No spec: pass --spec or set api.spec in the config');
      const { reports } = await recordApiCoverage(resolve(io.cwd, runDir), specs);
      for (const r of reports) io.out(apiCoverageMarkdown(r));
      if (o.min !== undefined && reports.some((r) => r.totals.operationRatio < o.min!)) process.exitCode = 1;
    });

  contract
    .command('from-mocks')
    .description('write an EZTest contract file from an eztest mock store')
    .requiredOption('--store <file>')
    .requiredOption('--consumer <name>')
    .requiredOption('--provider <name>')
    .option('-o, --out <dir>', 'output directory', 'contracts')
    .addOption(new Option('--matchers <style>').choices(['type', 'exact']).default('type'))
    .action(async (o: { store: string; consumer: string; provider: string; out: string; matchers: 'type' | 'exact' }) => {
      const c = contractFromMockStore(await loadStore(resolve(io.cwd, o.store)), o.consumer, o.provider, o.matchers);
      const dir = resolve(io.cwd, o.out);
      await mkdir(dir, { recursive: true });
      const file = join(dir, contractFileName(o.consumer, o.provider));
      await writeFile(file, JSON.stringify(contractToJson(c), null, 2));
      io.out(`wrote ${c.expectations.length} expectation(s) to ${file}`);
    });

  const server = async (o: { config?: string; env?: string; project?: string; server?: string; serverProject?: string }) => {
    const loaded = await load(o);
    const client = await serverClientFor(loaded, io.cwd, { ...(o.server ? { url: o.server } : {}), ...(o.serverProject ? { project: o.serverProject } : {}) });
    if (!client) throw new Error('No EZTest results server: set server.url in the config or pass --server <url>');
    return { loaded, client };
  };
  const serverOpts = (c: Command) => withConfig(c).option('--server <url>', 'EZTest results server URL (default server.url)').option('--server-project <name>', 'project on the results server (default server.project)');

  serverOpts(contract.command('publish'))
    .description('publish contract files to the EZTest results server for a consumer version')
    .argument('[paths...]', 'contract files or directories (default contracts.dir)')
    .requiredOption('--app-version <v>', 'consumer application version (e.g. the commit sha)')
    .option('--branch <name>', 'branch the version was built from (default contracts.branch)')
    .action(async (paths: string[], o) => {
      const { loaded, client } = await server(o);
      const files = await contractFiles(io, paths.length ? paths : [loaded.config.contracts?.dir ?? 'contracts']);
      if (!files.length) throw new Error('No contract files to publish');
      const branch = o.branch ?? loaded.config.contracts?.branch;
      for (const f of files) {
        const c = await readContractFile(f);
        const r = await client.publishContract(contractToJson(c), o.appVersion, branch);
        io.out(`${r.created ? 'published' : 'unchanged'} ${c.consumer} ${o.appVersion} -> ${c.provider} (${f}, ${r.hash.slice(0, 12)})`);
      }
    });

  serverOpts(contract.command('verify'))
    .description('verify contracts (files, or the results server) against a running provider; provider states come from contracts.provider.states')
    .argument('[paths...]', 'contract files or directories (default: fetch from the results server)')
    .option('--provider <name>', 'provider name (default contracts.provider.name)')
    .option('--base-url <url>', 'provider base URL (default contracts.provider.baseUrl)')
    .option('--provider-version <v>', 'provider version; with --publish the results are recorded on the results server')
    .option('--branch <name>', 'provider branch (recorded with the results; default contracts.branch)')
    .option('--consumer-branch <name>', 'fetch the latest contract per consumer on this branch')
    .option('--environment <name>', 'fetch the contracts of the consumer versions released to this environment')
    .option('--publish', 'record verification results on the results server')
    .option('--run <runDir>', 'record the results in this run (readiness gate "contracts")')
    .action(async (paths: string[], o) => {
      const loaded = await load(o);
      const pc = loaded.config.contracts?.provider;
      const providerName = o.provider ?? pc?.name;
      const baseUrl = o.baseUrl ?? pc?.baseUrl ?? loaded.config.baseUrl;
      if (!baseUrl) throw new Error('No provider base URL: pass --base-url or set contracts.provider.baseUrl');
      if (o.publish && !o.providerVersion) throw new Error('--publish needs --provider-version');
      const client = !paths.length || o.publish ? (await server(o)).client : undefined;
      const engine = await createEngine(loaded, { cwd: io.cwd, runOptions: { screenshots: 'off' } });
      try {
        const headers = async () => ({ ...(pc?.headers ?? {}), ...(pc?.asRole && engine.runOptions.apiAuth ? await engine.runOptions.apiAuth(pc.asRole, {} as never) : {}) });
        const ctx = { engine, baseUrl, resolveJourney: journeyFileResolver(io.cwd, loaded.config.journeysDir), headers };
        const opts = {
          baseUrl,
          stateHandlers: stateHandlersFromConfig(pc?.states ?? {}, ctx),
          ...(pc?.stateChangeUrl ? { stateChangeUrl: pc.stateChangeUrl } : {}),
          requestHeaders: headers,
          messageProducers: messageProducersFromConfig(pc?.messageProducers ?? {}, engine.runOptions.integration as Integration, ctx),
        };
        const todo: Array<{ contract: Contract; source: string; consumerVersion?: string }> = [];
        if (paths.length) {
          for (const f of await contractFiles(io, paths)) {
            const c = await readContractFile(f);
            if (!providerName || c.provider === providerName) todo.push({ contract: c, source: f });
          }
        } else {
          if (!providerName) throw new Error('Pass contract files, or --provider to fetch contracts from the results server');
          for (const pcx of await client!.contracts({ provider: providerName, ...(o.consumerBranch ? { branch: o.consumerBranch } : {}), ...(o.environment ? { environment: o.environment } : {}) })) {
            if (pcx.contract) todo.push({ contract: parseContract(pcx.contract, `${pcx.consumer} ${pcx.consumerVersion}`), source: `${pcx.consumer} ${pcx.consumerVersion} (results server)`, consumerVersion: pcx.consumerVersion });
          }
        }
        if (!todo.length) throw new Error(`No contracts to verify${providerName ? ` for provider ${providerName}` : ''}`);
        const results: ContractVerification[] = [];
        for (const t of todo) {
          const v = await verifyContract(t.contract, opts, { source: t.source, hash: contractHash(t.contract), ...(t.consumerVersion ? { consumerVersion: t.consumerVersion } : {}) });
          results.push(v);
          io.out(verificationText(v));
          if (o.publish) {
            const branch = o.branch ?? loaded.config.contracts?.branch;
            await client!.recordVerification({
              provider: v.provider, providerVersion: o.providerVersion, hash: v.hash, passed: v.passed,
              ...(v.consumerVersion ? { consumerVersion: v.consumerVersion } : {}), ...(branch ? { branch } : {}),
              failed: v.expectations.filter((e) => !e.passed).map((e) => `${e.description}: ${e.error ?? e.mismatches[0]?.message ?? 'failed'}`),
            });
          }
        }
        if (o.run) io.out(`recorded in ${o.run} (evidence ${await recordContractResults(resolve(io.cwd, o.run), { verifications: results })})`);
        process.exitCode = results.every((r) => r.passed) ? 0 : 1;
      } finally {
        await engine.close();
      }
    });

  serverOpts(contract.command('can-release'))
    .description('ask the EZTest results server whether a version can be released to an environment (exit 1 when not)')
    .option('--app <name>', 'application name (default contracts.app)')
    .requiredOption('--app-version <v>', 'version of the application (e.g. the commit sha)')
    .option('--environment <name>', 'target environment (default contracts.canRelease.environment)')
    .option('--json', 'print JSON')
    .option('--run <runDir>', 'record the answer in this run (readiness gate "contracts")')
    .action(async (o) => {
      const { loaded, client } = await server(o);
      const app = o.app ?? loaded.config.contracts?.app;
      if (!app) throw new Error('--app (or contracts.app) is required');
      const environment = o.environment ?? loaded.config.contracts?.canRelease?.environment;
      if (!environment) throw new Error('--environment (or contracts.canRelease.environment) is required');
      const r = await client.canRelease({ app, version: o.appVersion, environment });
      io.out(o.json ? JSON.stringify(r, null, 2) : canReleaseText(r));
      if (o.run) await recordContractResults(resolve(io.cwd, o.run), { canRelease: r });
      process.exitCode = r.releasable ? 0 : 1;
    });

  serverOpts(contract.command('record-release'))
    .description('record on the EZTest results server that a version is released to an environment')
    .option('--app <name>', 'application name (default contracts.app)')
    .requiredOption('--app-version <v>', 'version of the application (e.g. the commit sha)')
    .requiredOption('--environment <name>')
    .action(async (o) => {
      const { loaded, client } = await server(o);
      const app = o.app ?? loaded.config.contracts?.app;
      if (!app) throw new Error('--app (or contracts.app) is required');
      await client.recordRelease({ app, version: o.appVersion, environment: o.environment });
      io.out(`recorded ${app} ${o.appVersion} in ${o.environment}`);
    });

  // ------------------------------------------------------------------ spec- and proto-driven mocks
  const mock = program.commands.find((c) => c.name() === 'mock') ?? program.command('mock');
  mock
    .command('from-openapi')
    .description('serve a mock generated from an OpenAPI/Swagger spec (examples or seeded data; invalid requests get 400)')
    .argument('<spec>')
    .option('-p, --port <n>', 'port', (v) => parseInt(v, 10), 4710)
    .option('--seed <seed>', 'seed for generated data', '42')
    .option('--no-validate', 'do not validate requests')
    .option('--store <file>', 'instead of serving, write an eztest mock store (GET operations) to this file')
    .option('--for <seconds>', 'stop after N seconds', Number)
    .action(async (spec: string, o: { port: number; seed: string; validate: boolean; store?: string; for?: number }) => {
      const s = loadApiSpec(resolve(io.cwd, spec));
      if (o.store) {
        const store = mockStoreFromSpec(s, o.seed);
        await saveStore(resolve(io.cwd, o.store), store);
        io.out(`wrote ${store.recordings.length} recording(s) to ${o.store}`);
        return;
      }
      const server = await createOpenApiMock({ spec: s, port: o.port, seed: o.seed, validateRequests: o.validate });
      io.out(`mock of ${s.title || spec} (${s.operations.length} operations) listening on ${server.url}`);
      await waitForStop(o.for);
      await server.close();
      io.out(`stopped (${server.stats.served} served, ${server.stats.rejected} rejected, ${server.stats.unmatched} unmatched)`);
    });
  mock
    .command('grpc')
    .description('serve a gRPC mock from .proto files and a YAML/JSON responses file')
    .requiredOption('--proto <files>', 'proto file(s), comma separated', list)
    .requiredOption('--responses <file>', '"package.Service/Method": [{ when, response | stream | status, message }]')
    .option('-p, --port <n>', 'port', (v) => parseInt(v, 10), 50051)
    .option('--for <seconds>', 'stop after N seconds', Number)
    .action(async (o: { proto: string[]; responses: string; port: number; for?: number }) => {
      const responses = parseYaml(await readFile(resolve(io.cwd, o.responses), 'utf8')) as Record<string, never[]>;
      const server = await createGrpcMock({ proto: o.proto, responses, port: o.port, baseDir: io.cwd });
      io.out(`gRPC mock listening on ${server.address}`);
      await waitForStop(o.for);
      await server.close();
      io.out(`stopped (${server.calls.length} call(s))`);
    });
}
