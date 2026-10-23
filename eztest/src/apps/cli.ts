/**
 * `eztest apps ...`: metadata snapshots, change impact and permission
 * matrices for the packaged-app packs.
 *
 *   eztest apps snapshot servicenow -o before.json
 *   eztest apps impact servicenow --update-set "Q3 incident changes" --skipped journeys
 *   eztest apps impact sap --transport DEVK900123 journeys        # QAS (sap.url) vs DEV (sap.source)
 *   eztest apps impact workday --before r1.json --after r2.json --whats-new journeys
 *   eztest apps impact oracle --features 25d-features.csv journeys   # pod comparison when oracle.testPod is set
 *   eztest apps impact powerapps --app-before v1.pa.yaml --app-after v2.pa.yaml journeys
 *   eztest apps permissions servicenow --checks perms.yaml [--ui]
 *
 * impact exits 1 when a journey is broken; permissions exits 1 on a violation.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { chromium, type Browser, type Page } from '../browser/index.js';
import type { LoadedConfig } from '../config/index.js';
import { enableAddons } from '../engine/index.js';
import { loadJourneys } from '../cli/journeys.js';
import type { AppChange, AppSnapshot, ImpactReport } from './common/impact.js';
import { parseCsvRows } from './common/release-notes.js';
import { reveal } from './common/kit.js';
import type { MatrixReport } from './common/permissions.js';
import { APP_PACKS, type AppPackName, type AppPacks } from './index.js';
import { fioriLogin } from './sap/steps.js';
import { serviceNowLogin } from './servicenow/steps.js';
import { workdayLogin } from './workday/steps.js';
import { usernameOf, passwordHandle } from './common/http.js';
import type { SecretRegistry } from '../identity/handle.js';
import { identityVaultFromConfig } from '../identity/from-config.js';

interface IO { out(s: string): void; err(s: string): void; cwd: string }
type Load = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;

const list = (v: string, prev: string[] = []) => [...prev, v];

export function registerAppCommands(program: Command, io: IO, load: Load): void {
  const apps = program.command('apps').description('packaged-app packs (SAP Fiori, ServiceNow, Workday, Oracle, Power Apps): snapshots, change impact, permission matrices');
  const cfgOpts = (c: Command) => c.option('-c, --config <file>').option('-e, --env <name>').option('--project <name>');
  const read = async (f: string) => readFile(resolve(io.cwd, f), 'utf8');
  const readJson = async <T>(f: string) => JSON.parse(await read(f)) as T;

  async function withPack<T>(o: { config?: string; env?: string; project?: string }, pack: string, fn: (p: AppPacks, secrets: SecretRegistry) => Promise<T>): Promise<T> {
    if (!(APP_PACKS as readonly string[]).includes(pack)) throw new Error(`Unknown pack "${pack}" (one of ${APP_PACKS.join(', ')})`);
    const loaded = await load(o);
    const vault = identityVaultFromConfig(loaded.config, { cwd: io.cwd, masker: loaded.masker });
    const addons = await enableAddons(loaded, { cwd: io.cwd, vault });
    try {
      if (!addons.apps?.[pack as AppPackName]) throw new Error(`No ${pack}: block in the configuration`);
      return await fn(addons.apps, vault.registry);
    } finally {
      addons.off();
    }
  }

  async function withBrowser<T>(fn: (b: Browser) => Promise<T>): Promise<T> {
    const b = await chromium.launch();
    try {
      return await fn(b);
    } finally {
      await b.close();
    }
  }

  cfgOpts(apps.command('snapshot'))
    .description('save a metadata snapshot of a pack (dictionary, $metadata, WQL fields + task forms, REST describe, canvas app source)')
    .argument('<pack>', APP_PACKS.join(' | '))
    .requiredOption('-o, --out <file>', 'output JSON')
    .option('--release <name>', 'label the snapshot (e.g. 2026R2, 25D, QAS)')
    .option('--system <which>', 'sap: target (sap.url) or source (sap.source)', 'target')
    .option('--pod <which>', 'oracle: current or test (oracle.testPod)', 'current')
    .option('--tasks-as <role>', 'workday: sign in as this role and crawl the configured task forms')
    .option('--app-source <file>', 'powerapps: the app source (.pa.yaml)')
    .option('--dataverse', 'powerapps: snapshot Dataverse metadata (D365 format) instead of the app')
    .action(async (pack: string, o) => {
      await withPack(o, pack, async (p, secrets) => {
        let snap: unknown;
        if (pack === 'sap') snap = await p.sap!.snapshot({ release: o.release, system: o.system });
        else if (pack === 'servicenow') snap = await p.servicenow!.snapshot({ release: o.release });
        else if (pack === 'oracle') snap = await p.oracle!.snapshot({ release: o.release, pod: o.pod });
        else if (pack === 'powerapps') {
          if (o.dataverse) snap = await p.powerapps!.dataverseSnapshot();
          else {
            if (!o.appSource) throw new Error('powerapps snapshot needs --app-source <file.pa.yaml> (or --dataverse)');
            snap = p.powerapps!.snapshot({ source: await read(o.appSource), release: o.release });
          }
        } else {
          const wd = p.workday!;
          if (!o.tasksAs) snap = await wd.snapshot({ release: o.release });
          else {
            snap = await withBrowser(async (b) => {
              const page = await (await b.newContext()).newPage();
              const reg = secrets;
              const u = wd.config.users[o.tasksAs];
              if (!u) throw new Error(`Unknown Workday role ${o.tasksAs}`);
              const r = await workdayLogin(page, wd.config.uiUrl ?? `${wd.config.url.replace(/\/+$/, '')}/${wd.config.tenant}`, await usernameOf(u, reg), (await reveal(passwordHandle(u, reg, 'workday'))) ?? '', 15_000);
              if (!r.ok) throw new Error(`Workday sign-in failed: ${r.error}`);
              return wd.snapshot({ release: o.release, page });
            });
          }
        }
        await writeFile(resolve(io.cwd, o.out), JSON.stringify(snap, null, 2));
        const s = snap as AppSnapshot & { entities?: Record<string, unknown> };
        io.out(`wrote ${o.out}: ${Object.keys(s.objects ?? s.entities ?? {}).length} objects`);
      });
    });

  cfgOpts(apps.command('impact'))
    .description('list the journeys a change breaks (snapshots, update sets, upgrades, transports, release notes, app versions)')
    .argument('<pack>', APP_PACKS.join(' | '))
    .argument('[paths...]', 'journey files or directories', ['journeys'])
    .option('--before <file>', 'snapshot before the change')
    .option('--after <file>', 'snapshot after the change')
    .option('--update-set <name>', 'servicenow: an update set (repeatable)', list, [])
    .option('--skipped', 'servicenow: records the last upgrade skipped')
    .option('--upgrade <name>', 'servicenow: limit skipped records to this upgrade')
    .option('--transport <nr>', 'sap: a transport request read through ADT (repeatable)', list, [])
    .option('--transport-file <file>', 'sap: a transport object list (ADT XML, E071 JSON or "R3TR TABL VBAK" lines; repeatable)', list, [])
    .option('--whats-new', 'workday: include the configured What\'s New report')
    .option('--features <file>', 'oracle: the quarterly update feature list (CSV or JSON rows)')
    .option('--release <name>', 'release/update label for release notes')
    .option('--app-before <file>', 'powerapps: app source before (.pa.yaml)')
    .option('--app-after <file>', 'powerapps: app source after (.pa.yaml)')
    .option('--dataverse-before <file>', 'powerapps: Dataverse snapshot before (eztest apps snapshot powerapps --dataverse)')
    .option('--dataverse-after <file>', 'powerapps: Dataverse snapshot after')
    .option('-o, --out <file>', 'write the full report as JSON')
    .action(async (pack: string, paths: string[], o) => {
      await withPack(o, pack, async (p, secrets) => {
        const before = o.before ? await readJson<AppSnapshot>(o.before) : undefined;
        const after = o.after ? await readJson<AppSnapshot>(o.after) : undefined;
        let changes: AppChange[];
        if (pack === 'servicenow') changes = await p.servicenow!.changes({ updateSets: o.updateSet, skipped: !!o.skipped, upgrade: o.upgrade, before, after });
        else if (pack === 'sap') {
          const files = await Promise.all((o.transportFile as string[]).map(read));
          changes = await p.sap!.changes({ transports: [...o.transport, ...files], before, after });
        } else if (pack === 'workday') changes = await p.workday!.changes({ before, after, whatsNew: !!o.whatsNew, release: o.release });
        else if (pack === 'oracle') {
          const text = o.features ? await read(o.features) : undefined;
          const features = text ? (text.trim().startsWith('[') ? (JSON.parse(text) as Array<Record<string, string>>) : parseCsvRows(text)) : undefined;
          changes = await p.oracle!.changes({ before, after, features, update: o.release });
        } else {
          changes = p.powerapps!.changes({
            beforeSource: o.appBefore ? await read(o.appBefore) : undefined, afterSource: o.appAfter ? await read(o.appAfter) : undefined,
            dataverseBefore: o.dataverseBefore ? await readJson(o.dataverseBefore) : undefined, dataverseAfter: o.dataverseAfter ? await readJson(o.dataverseAfter) : undefined,
          });
        }
        const { journeys, errors } = await loadJourneys(paths, io.cwd);
        for (const e of errors) io.err(`${e.file}: ${e.message}`);
        const integ = p[pack as AppPackName] as { impact(c: AppChange[], j: typeof journeys): ImpactReport };
        const report = integ.impact(changes, journeys);
        if (o.out) await writeFile(resolve(io.cwd, o.out), JSON.stringify(report, null, 2));
        io.out(JSON.stringify({ changes: report.changes.length, impacted: report.impacted.map((j) => ({ journeyId: j.journeyId, breaking: j.breaking, reasons: j.reasons.map((r) => `${r.severity} ${r.change} ${r.matched}: ${r.detail}`) })), untested: report.untested.map((c) => c.detail) }, null, 2));
        process.exitCode = report.impacted.some((j) => j.breaking > 0) ? 1 : 0;
      });
    });

  cfgOpts(apps.command('permissions'))
    .description('check a pack\'s role/permission matrix for every configured user (API as each user; --ui also checks the UI)')
    .argument('<pack>', APP_PACKS.join(' | '))
    .requiredOption('--checks <file>', 'YAML/JSON list of checks (see docs/apps/<pack>.md)')
    .option('--ui', 'also sign in as each user in a browser and check what the UI shows')
    .option('-o, --out <file>', 'write the full report as JSON')
    .action(async (pack: string, o) => {
      await withPack(o, pack, async (p, secrets) => {
        const raw = parseYaml(await read(o.checks)) as unknown;
        const checks = (Array.isArray(raw) ? raw : (raw as { checks?: unknown })?.checks) as never[];
        if (!Array.isArray(checks)) throw new Error(`${o.checks}: expected a list of checks (or { checks: [...] })`);
        const run = async (pages?: Record<string, Page>): Promise<MatrixReport> => {
          const ui = pages ? { pages } : undefined;
          if (pack === 'servicenow') return p.servicenow!.permissionMatrix(checks, ui);
          if (pack === 'sap') return p.sap!.permissionMatrix(checks, ui);
          if (pack === 'workday') return p.workday!.permissionMatrix(checks, ui);
          if (pack === 'oracle') return p.oracle!.permissionMatrix(checks, ui);
          return p.powerapps!.permissionMatrix(checks, ui);
        };
        const report = o.ui
          ? await withBrowser(async (b) => {
            const integ = p[pack as AppPackName] as { config: { users: Record<string, { username: string; password: string }>; url?: string; instanceUrl?: string; client?: string; launchpadPath?: string } };
            const reg = secrets;
            const pages: Record<string, Page> = {};
            for (const [role, u] of Object.entries(integ.config.users)) {
              const page = await (await b.newContext()).newPage();
              const pw = (await reveal(passwordHandle(u, reg, role))) ?? '';
              if (pack === 'servicenow') await serviceNowLogin(page, integ.config.instanceUrl!, await usernameOf(u, reg), pw, 15_000);
              if (pack === 'sap') await fioriLogin(page, `${integ.config.url!.replace(/\/+$/, '')}${integ.config.launchpadPath}?sap-client=${integ.config.client}`, await usernameOf(u, reg), pw, 15_000);
              pages[role] = page;
            }
            return run(pages);
          })
          : await run();
        if (o.out) await writeFile(resolve(io.cwd, o.out), JSON.stringify(report, null, 2));
        for (const v of report.violations) io.out(`VIOLATION ${v.user}: ${v.subject} expected ${v.expected}${v.api !== undefined ? `, API reports ${v.api}` : ''}${v.ui !== undefined ? `, UI shows ${v.ui}` : ''}`);
        io.out(`${report.results.length} checks for ${report.users.length} users: ${report.violations.length} violation(s)`);
        process.exitCode = report.passed ? 0 : 1;
      });
    });
}
