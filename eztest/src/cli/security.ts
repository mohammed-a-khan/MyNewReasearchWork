/**
 * `eztest api-scan`: the API security scan pack. It builds targets from an
 * OpenAPI spec and/or a scan file, sends the deterministic probes (see
 * src/lenses/security-api.ts), prints an OWASP-mapped report and, with
 * --readiness, records it into a run directory so the apiSecurity gate can
 * cite it.
 *
 * Safe by default: the scan runs only against hosts on security.api
 * .allowedHosts and needs --yes; mutating probes need security.api
 * .allowMutating (or --allow-mutating).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import type { LoadedConfig } from '../config/index.js';
import { identityVaultFromConfig } from '../identity/index.js';
import { loadApiSpec } from '../contracts/index.js';
import { apiScanMarkdown, recordApiSecurityScan, scanApiSecurity, targetsFromSpec, ALL_PROBES, type ApiProbeName, type ApiScanConfig, type ApiTarget } from '../lenses/index.js';
import type { CliIO } from './program.js';

type Loader = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;

interface ScanFile {
  baseUrl?: string;
  spec?: string;
  token?: string;
  otherToken?: string;
  authHeader?: string;
  ids?: Record<string, [string, string]>;
  sample?: Record<string, string>;
  targets?: ApiTarget[];
  probes?: ApiProbeName[];
  sensitiveProperties?: string[];
  rateLimitBurst?: number;
}

export function registerSecurityCommands(program: Command, io: CliIO, load: Loader): void {
  program
    .command('api-scan')
    .description('run the deterministic API security scan pack (OWASP API Top 10) against a configured non-production host')
    .argument('[scanfile]', 'a scan file (YAML/JSON): baseUrl, spec, token/otherToken (secret://), ids, targets, probes')
    .option('-c, --config <file>', 'config file')
    .option('-e, --env <name>', 'environment name')
    .option('--project <name>', 'project overlay')
    .option('--base <url>', 'base URL of the API (overrides the scan file)')
    .option('--spec <file>', 'OpenAPI/Swagger spec to enumerate endpoints from')
    .option('--probes <list>', 'only these probes (comma separated)', (v: string) => v.split(',').map((s) => s.trim()))
    .option('--yes', 'confirm: send probe requests (required; only non-production hosts)')
    .option('--allow-mutating', 'allow probes that create/change data (mass assignment, injection on writes)')
    .option('--readiness <runDir>', 'record the scan into this run directory for the apiSecurity gate')
    .option('--json', 'print the report as JSON')
    .action(async (scanfile: string | undefined, o: { config?: string; env?: string; project?: string; base?: string; spec?: string; probes?: string[]; yes?: boolean; allowMutating?: boolean; readiness?: string; json?: boolean }) => {
      const loaded = await load(o);
      const file: ScanFile = scanfile ? ((parseYaml(await readFile(resolve(io.cwd, scanfile), 'utf8')) as ScanFile) ?? {}) : {};
      const baseUrl = o.base ?? file.baseUrl;
      if (!baseUrl) throw new Error('api-scan needs a base URL (--base or baseUrl in the scan file)');
      const secCfg = loaded.config.security.api;
      const vault = identityVaultFromConfig(loaded.config, { cwd: io.cwd, masker: loaded.masker, env: { ...io.env, ...loaded.variables } });
      const secret = async (v?: string): Promise<string | undefined> => {
        if (!v) return undefined;
        const s = v.startsWith('secret://') ? await vault.registry.resolve(v) : v;
        loaded.masker.add(s);
        return s;
      };
      const token = await secret(file.token);
      const otherToken = await secret(file.otherToken);

      let targets: ApiTarget[] = file.targets ?? [];
      const specFile = o.spec ?? file.spec;
      if (!targets.length && specFile) {
        const spec = loadApiSpec(resolve(io.cwd, specFile));
        targets = targetsFromSpec(spec, { ...(file.ids ? { ids: file.ids } : {}), ...(file.sample ? { sample: file.sample } : {}) });
        for (const w of spec.warnings) io.err(`spec warning: ${w}`);
      }
      if (!targets.length) throw new Error('api-scan has no endpoints: give a scan file with targets, or --spec to enumerate from an OpenAPI spec');

      const probes = (o.probes ?? file.probes) as ApiProbeName[] | undefined;
      const bad = (probes ?? []).filter((p) => !ALL_PROBES.includes(p));
      if (bad.length) throw new Error(`unknown probe(s): ${bad.join(', ')} (known: ${ALL_PROBES.join(', ')})`);

      const cfg: ApiScanConfig = {
        baseUrl, allowedHosts: secCfg.allowedHosts, confirm: !!o.yes,
        allowMutating: o.allowMutating ?? secCfg.allowMutating,
        ...(token ? { token: () => token } : {}), ...(otherToken ? { otherToken: () => otherToken } : {}),
        ...(file.authHeader ? { authHeaders: (t: string) => ({ [file.authHeader!.split(':')[0].trim()]: file.authHeader!.split(':').slice(1).join(':').trim().replace('{}', t) }) } : {}),
        ...(probes ? { probes } : {}), ...(file.sensitiveProperties ? { sensitiveProperties: file.sensitiveProperties } : {}),
        ...(file.rateLimitBurst ? { rateLimitBurst: file.rateLimitBurst } : {}),
        mask: (s: string) => loaded.masker.mask(s),
      };

      const report = await scanApiSecurity(cfg, targets);
      if (o.json) io.out(JSON.stringify(report, null, 2));
      else io.out(apiScanMarkdown(report));
      if (o.readiness) {
        const runDir = resolve(io.cwd, o.readiness);
        if (!existsSync(runDir)) throw new Error(`--readiness: no such run directory ${o.readiness}`);
        const id = await recordApiSecurityScan(runDir, report);
        io.out(`recorded as evidence ${id} in ${o.readiness} (add the apiSecurity gate to the readiness policy)`);
      }
      const failOn = secCfg.failOn;
      const order = ['info', 'low', 'medium', 'high'];
      const blocking = report.findings.filter((f) => order.indexOf(f.severity) >= order.indexOf(failOn));
      process.exitCode = blocking.length ? 2 : 0;
    });
}
