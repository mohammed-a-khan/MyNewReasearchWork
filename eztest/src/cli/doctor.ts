/**
 * `eztest doctor`: check the environment (Node, browsers, config per project,
 * database connections, plugins, results server). `--json` prints one
 * machine-readable report (for container health checks and CI gates).
 */
import { extname } from 'node:path';
import type { Command } from 'commander';
import { listProjects, type LoadedConfig } from '../config/index.js';
import { CONFIG_VERSION } from '../config/schema.js';
import { EZTEST_VERSION } from '../ops/version.js';
import { PLUGIN_API_VERSION } from '../plugins/api.js';
import { effectiveSummary } from './effective.js';
import { doctorDatabases } from './queries.js';
import { serverClientFor } from './scale.js';
import type { CliIO } from './program.js';

type Loader = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'error' | 'skipped';
  detail?: string;
  lines?: string[];
}

export interface DoctorReport {
  ok: boolean;
  eztest: string;
  configVersion: number;
  pluginApiVersion: number;
  node: string;
  platform: string;
  checks: DoctorCheck[];
}

export function registerDoctorCommand(program: Command, io: CliIO, load: Loader): void {
  program
    .command('doctor')
    .description('check the environment: Node, browsers, config (and the effective config per project), database connections, plugins, results server')
    .option('-c, --config <file>')
    .option('-e, --env <name>', 'environment to check')
    .option('--project <name>', 'only this project (default: every project in the config)')
    .option('--no-browser', 'skip the browser launch check')
    .option('--no-db', 'skip database connection checks')
    .option('--no-server', 'skip the results server check')
    .option('--json', 'print a machine-readable report')
    .action(async (o: { config?: string; env?: string; project?: string; browser?: boolean; db?: boolean; server?: boolean; json?: boolean }) => {
      const checks: DoctorCheck[] = [];
      const say = (s: string) => {
        if (!o.json) io.out(s);
      };
      const major = Number(process.versions.node.split('.')[0]);
      checks.push({ name: 'node', status: major >= 20 ? 'ok' : 'error', detail: process.versions.node });
      say(`node        ${process.versions.node} ${major >= 20 ? 'ok' : 'needs >= 20'}`);
      if (o.browser !== false) {
        const { chromium, findChromium, findFirefox, browserCacheDir } = await import('../browser/index.js');
        const howTo = [
          `install: eztest install-browsers chromium   (Chrome for Testing into ${browserCacheDir()})`,
          '         eztest install-browsers firefox    (Firefox from Mozilla, same cache)',
          '         or install Google Chrome / Microsoft Edge / Firefox, or set EZTEST_CHROMIUM_PATH / EZTEST_FIREFOX_PATH',
        ];
        let found: { executablePath: string; source: string } | undefined;
        try {
          found = findChromium();
          const b = await chromium.launch();
          const lines = [`${found.executablePath} (${found.source})`];
          checks.push({ name: 'chromium', status: 'ok', detail: b.version(), lines });
          say(`chromium    ${b.version()} ok (${found.source}: ${found.executablePath})`);
          await b.close();
        } catch (e) {
          const msg = (e as Error).message.split('\n')[0];
          checks.push({ name: 'chromium', status: 'error', detail: msg, lines: [...(found ? [`${found.executablePath} (${found.source})`] : []), ...howTo] });
          say(`chromium    not available: ${msg}`);
          for (const l of howTo) say(`            ${l}`);
        }
        try {
          const ff = findFirefox();
          checks.push({ name: 'firefox', status: 'ok', detail: `${ff.executablePath} (${ff.source})` });
          say(`firefox     found (${ff.source}: ${ff.executablePath})`);
        } catch {
          checks.push({ name: 'firefox', status: 'skipped', detail: 'not installed (optional): eztest install-browsers firefox' });
          say('firefox     not installed (optional): eztest install-browsers firefox');
        }
      }
      const projects = o.project ? [o.project] : listProjects({ cwd: io.cwd, configFile: o.config, environment: io.env });
      let firstLoaded: LoadedConfig | undefined;
      for (const project of projects.length ? projects : [undefined]) {
        const label = project ? `project ${project}${o.env ? ` / ${o.env}` : ''}` : 'config';
        try {
          const l = await load({ ...o, project });
          firstLoaded ??= l;
          const sources = l.sources.map((x) => (x.startsWith(io.cwd) ? x.slice(io.cwd.length + 1) : x)).join(' < ');
          const lines = [...effectiveSummary(l), ...l.warnings.map((w) => `warning: ${w}`)];
          say(`${project ? label : 'config     '} ok (${sources})`);
          for (const line of lines) say(`            ${line}`);
          const dbLines: string[] = [];
          let dbOk = true;
          if (o.db !== false) dbOk = await doctorDatabases(l, { ...io, out: (s: string) => (o.json ? dbLines.push(s) : io.out(s)) } as CliIO);
          checks.push({ name: label, status: !dbOk ? 'error' : l.warnings.length ? 'warn' : 'ok', detail: sources, lines: [...lines, ...dbLines] });
        } catch (e) {
          checks.push({ name: label, status: 'error', detail: (e as Error).message });
          say(`${label} ERROR ${(e as Error).message}`);
        }
      }
      if (firstLoaded?.config.plugins.length) {
        try {
          const { loadPlugins } = await import('../plugins/index.js');
          const p = await loadPlugins(firstLoaded.config.plugins as never, { cwd: io.cwd });
          checks.push({ name: 'plugins', status: 'ok', detail: p.plugins.map((x) => `${x.name}${x.version ? `@${x.version}` : ''}`).join(', ') });
          say(`plugins     ${p.plugins.map((x) => x.name).join(', ')} ok (plugin API v${PLUGIN_API_VERSION})`);
          p.off();
        } catch (e) {
          checks.push({ name: 'plugins', status: 'error', detail: (e as Error).message });
          say(`plugins     ERROR ${(e as Error).message}`);
        }
      }
      if (o.server !== false && firstLoaded?.config.server) {
        try {
          const client = await serverClientFor(firstLoaded, io.cwd);
          await client!.health();
          const me = client!.o.token ? await client!.me() : undefined;
          const detail = `${client!.base}${me ? ` as ${me.id}` : ''}`;
          checks.push({ name: 'server', status: 'ok', detail });
          say(`server      ${detail} ok`);
        } catch (e) {
          checks.push({ name: 'server', status: 'error', detail: (e as Error).message });
          say(`server      ERROR ${(e as Error).message}`);
        }
      }
      const ok = !checks.some((c) => c.status === 'error');
      if (o.json) {
        const report: DoctorReport = { ok, eztest: EZTEST_VERSION, configVersion: CONFIG_VERSION, pluginApiVersion: PLUGIN_API_VERSION, node: process.versions.node, platform: `${process.platform}-${process.arch}`, checks };
        io.out(JSON.stringify(report, null, 2));
      } else if (extname(o.config ?? '') === '.json') io.out('tip: YAML configs support comments');
      // A missing browser is reported but (as before) does not fail the doctor on its own.
      process.exitCode = checks.some((c) => c.status === 'error' && c.name !== 'chromium') ? 1 : 0;
    });
}
