/** Operations commands: monitor, keys, evidence packs, mock servers. */
import { Command, Option } from 'commander';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import type { LoadedConfig } from '../config/index.js';
import { createEngine } from '../engine/index.js';
import { runMonitor, renderStatusPage, loadMonitorState, type AlertChannel } from '../monitor/index.js';
import { generateSigningKey, createEvidencePack, verifyEvidencePack, renderPackSummary, type RegulatoryProfileId } from '../evidence-pack/index.js';
import { createMockServer, checkDrift, loadStore } from '../mocks/index.js';
import { loadJourneys, filterJourneys } from './journeys.js';
import type { CliIO } from './program.js';

type Loader = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;

function list(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Resolve on SIGINT/SIGTERM (or never in tests that pass their own signal). */
function abortOnSignals(): AbortController {
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return ac;
}

export function registerOpsCommands(program: Command, io: CliIO, load: Loader): void {
  // ------------------------------------------------------------------ monitor
  program
    .command('monitor')
    .description('run journeys tagged @monitor on a schedule against a live environment; alert on state changes')
    .argument('[paths...]', 'journey files or directories (default: journeysDir)')
    .option('-c, --config <file>')
    .option('-e, --env <name>')
    .option('--project <name>', 'project overlay (projects.<name>)')
    .option('-i, --interval <seconds>', 'seconds between runs', (v) => Number(v), 300)
    .option('-n, --iterations <n>', 'stop after n runs (default: until Ctrl+C)', (v) => parseInt(v, 10))
    .option('--webhook <urls>', 'alert webhooks (Slack/Teams compatible), comma separated', list)
    .option('--failures <n>', 'consecutive failures before alerting (flap guard)', (v) => parseInt(v, 10), 2)
    .option('--allow-writes', 'allow journeys that submit forms or call write APIs')
    .option('--status-page <file>', 'HTML status page to refresh after every run', 'eztest-monitor/status.html')
    .action(async (paths: string[], o) => {
      const loaded = await load(o);
      const { journeys: all, errors } = await loadJourneys(paths.length ? paths : [loaded.config.journeysDir], io.cwd);
      for (const e of errors) io.err(`error: ${e.file}: ${e.message}`);
      const journeys = filterJourneys(all, { tags: ['monitor', 'monitor-safe'] });
      if (journeys.length === 0) {
        io.err('No journeys tagged @monitor (monitors only run journeys explicitly marked safe for production).');
        process.exitCode = 1;
        return;
      }
      const engine = await createEngine(loaded, { cwd: io.cwd, runOptions: { screenshots: 'on-failure' } });
      const statusPage = resolve(io.cwd, o.statusPage);
      await mkdir(dirname(statusPage), { recursive: true });
      const alerts: AlertChannel[] = (o.webhook ?? []).map((url: string) => ({ type: 'webhook', url }));
      alerts.push({ type: 'callback', name: 'console', fn: (a) => io.out(`ALERT ${a.text}`) });
      const stateFile = resolve(io.cwd, '.eztest', 'monitor-state.json');
      const ac = abortOnSignals();
      try {
        const state = await runMonitor({
          journeys,
          run: (j) => engine.run(j),
          intervalMs: o.interval * 1000,
          iterations: o.iterations,
          signal: ac.signal,
          stateFile,
          alerts,
          failureThreshold: o.failures,
          outputDir: engine.runOptions.outputDir,
          allowWrites: !!o.allowWrites,
          onEvent: (e) => {
            if (e.type === 'run') {
              const s = e.result.summary;
              io.out(`[${new Date().toISOString()}] run ${e.tick}: ${s.passed + s.passedHealed}/${s.total} up`);
              void loadMonitorState(stateFile, new Date().toISOString())
                .then((st) => writeFile(statusPage, renderStatusPage(st)))
                .catch((err: unknown) => io.err(`status page: ${(err as Error).message}`));
            } else if (e.type === 'skip') io.out(`tick ${e.tick} skipped (previous run still going)`);
            else if (e.type === 'run-error') io.err(`run ${e.tick} failed to execute: ${e.error}`);
          },
        });
        await writeFile(statusPage, renderStatusPage(state));
        io.out(`status page: ${statusPage}`);
      } finally {
        await engine.close();
      }
    });

  // ------------------------------------------------------------------ keys
  program
    .command('keys')
    .description('signing keys for evidence packs')
    .command('generate')
    .description('create an ed25519 key pair (private key written with mode 0600)')
    .option('-o, --out <prefix>', 'file prefix', 'eztest-signing')
    .action(async (o: { out: string }) => {
      const k = generateSigningKey();
      const base = resolve(io.cwd, o.out);
      await writeFile(`${base}.key.pem`, k.privateKeyPem, { mode: 0o600 });
      await chmod(`${base}.key.pem`, 0o600);
      await writeFile(`${base}.pub.pem`, k.publicKeyPem);
      io.out(`private key: ${base}.key.pem (keep secret; do not commit)`);
      io.out(`public key:  ${base}.pub.pem (share with auditors)`);
    });

  // ------------------------------------------------------------------ evidence packs
  const evidence = program.commands.find((c) => c.name() === 'evidence') ?? program.command('evidence');
  evidence
    .command('pack')
    .description('create a signed, tamper-evident evidence pack (ZIP) for a run')
    .argument('<runDir>')
    .requiredOption('--key <file>', 'ed25519 private key PEM')
    .requiredOption('--signer <name>', 'name of the person signing')
    .option('--role <role>', 'signer role', 'QA Lead')
    .option('--meaning <text>', 'meaning of the signature, e.g. "Approved for release"')
    .addOption(new Option('--profile <id>').choices(['generic', 'csa-part11', 'sox']).default('generic'))
    .option('-o, --out <file>', 'output ZIP (default <runDir>/evidence-pack.zip)')
    .option('--extra <files>', 'extra files to include (specs, approvals)', list)
    .action(async (runDir: string, o) => {
      const dir = resolve(io.cwd, runDir);
      const out = resolve(io.cwd, o.out ?? join(runDir, 'evidence-pack.zip'));
      const r = await createEvidencePack(dir, out, {
        privateKeyPem: await readFile(resolve(io.cwd, o.key), 'utf8'),
        signer: { name: o.signer, role: o.role, meaning: o.meaning },
        regulatoryProfile: o.profile as RegulatoryProfileId,
        extraFiles: (o.extra ?? []).map((f: string) => resolve(io.cwd, f)),
      });
      await writeFile(out.replace(/\.zip$/i, '') + '-summary.html', renderPackSummary(r.manifest, { format: 'html' }));
      io.out(`pack: ${r.outFile} (${r.bytes} bytes, sha256 ${r.sha256})`);
    });
  evidence
    .command('verify-pack')
    .description('verify an evidence pack: signature, every file hash, and the evidence chain')
    .argument('<zip>')
    .requiredOption('--pub <file>', 'signer public key PEM')
    .action(async (zip: string, o: { pub: string }) => {
      const r = await verifyEvidencePack(resolve(io.cwd, zip), await readFile(resolve(io.cwd, o.pub), 'utf8'));
      io.out(`${r.ok ? 'VALID' : 'INVALID'}: signature ${r.signatureValid ? 'ok' : 'FAILED'}, ${r.filesChecked} files checked`);
      for (const p of r.problems) io.err(`  ${p}`);
      process.exitCode = r.ok ? 0 : 1;
    });

  // ------------------------------------------------------------------ mocks
  const mock = program.command('mock').description('service virtualization: record, replay, fault injection, drift');
  const serve = (mode: 'record' | 'replay') =>
    mock
      .command(mode)
      .description(mode === 'record' ? 'proxy to a real service and record request/response pairs' : 'serve recorded responses (unmatched -> 501)')
      .requiredOption('--store <file>', 'JSON recordings store')
      .option('--target <url>', 'real service base URL (record)')
      .option('-p, --port <n>', 'port', (v) => parseInt(v, 10), 4700)
      .option('--faults <file>', 'YAML/JSON fault rules (latency, status, drop)')
      .option('--for <seconds>', 'stop after N seconds (default: until Ctrl+C)', (v) => Number(v))
      .action(async (o) => {
        if (mode === 'record' && !o.target) throw new Error('--target is required for record');
        const faults = o.faults ? ((await import('yaml')).parse(await readFile(resolve(io.cwd, o.faults), 'utf8')) as never) : undefined;
        const server = await createMockServer({ mode, store: resolve(io.cwd, o.store), target: o.target, port: o.port, faults });
        io.out(`mock ${mode} listening on ${server.url}${o.target ? ` -> ${o.target}` : ''}`);
        const ac = abortOnSignals();
        await new Promise<void>((r) => {
          if (o.for) setTimeout(r, o.for * 1000);
          ac.signal.addEventListener('abort', () => r());
        });
        await server.close();
        io.out(`stopped (${server.recordings.length} recordings)`);
      });
  serve('record');
  serve('replay');
  mock
    .command('drift')
    .description('re-send recorded GETs to the real service and report response-shape drift')
    .requiredOption('--store <file>')
    .requiredOption('--target <url>')
    .option('--bearer <token>', 'bearer token for the real service (prefer an env var)')
    .action(async (o: { store: string; target: string; bearer?: string }) => {
      const r = await checkDrift(resolve(io.cwd, o.store), o.target, o.bearer ? { auth: { bearer: o.bearer } } : {});
      io.out(JSON.stringify(r, null, 2));
      process.exitCode = r.drifted > 0 ? 1 : 0;
    });
}
