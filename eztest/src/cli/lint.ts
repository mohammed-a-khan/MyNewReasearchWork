/** `eztest lint`: anti-patterns and departures from the EZTest Project Guide in journeys, features, code and data; CI friendly. */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Option, type Command } from 'commander';
import type { LoadedConfig } from '../config/index.js';
import { featureDirsFrom } from '../bdd/load.js';
import { defaultLintPaths, formatJunit, formatSarif, formatText, LINT_RULES, lintExitCode, lintPaths, type LintRule, type LintSeverity } from '../lint/index.js';

export interface LintIO {
  out(s: string): void;
  err(s: string): void;
  cwd: string;
}

type Loader = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;

function ruleOverride(v: string, prev: Record<string, string> = {}): Record<string, string> {
  const m = /^([\w-]+)=(error|warning|info|off)$/.exec(v.trim());
  if (!m) throw new Error(`--rule expects name=error|warning|info|off, got "${v}"`);
  if (!(m[1] in LINT_RULES)) throw new Error(`unknown lint rule "${m[1]}" (rules: ${Object.keys(LINT_RULES).join(', ')})`);
  return { ...prev, [m[1]]: m[2] };
}

export function registerLintCommand(program: Command, io: LintIO, load: Loader): void {
  program
    .command('lint')
    .description('check journeys, features, code, test data and config against the EZTest Project Guide: hard waits, fragile or repeated selectors, unchecked actions, plain-text secrets, missing ids and tags, undefined steps, undeclared dependencies, hard-coded hosts, files outside the layout')
    .argument('[paths...]', 'files or directories (default: journeysDir, the feature folders, and shared/, config/, eztest.config.* and .env.example when they exist)')
    .option('-c, --config <file>', 'config file')
    .option('-e, --env <name>', 'environment name')
    .option('--project <name>', 'project overlay (one application: its journeys, step definitions and variables)')
    .addOption(new Option('-f, --format <format>', 'output format').choices(['text', 'json', 'sarif', 'junit']).default('text'))
    .option('-o, --output <file>', 'write the report to a file (e.g. for code scanning or the CI test view)')
    .option('--max-warnings <n>', 'fail when there are more warnings than this', (v) => parseInt(v, 10))
    .option('--translated', 'the UI is translated: report text-only locators')
    .option('--rule <name=severity>', 'override a rule severity (repeatable)', ruleOverride)
    .action(async (paths: string[], o: { config?: string; env?: string; project?: string; format: string; output?: string; maxWarnings?: number; translated?: boolean; rule?: Record<string, string> }) => {
      let cfgLint: { translatedUi: boolean; rules: Record<string, string>; maxWarnings?: number } = { translatedUi: false, rules: {} };
      let defaults = ['journeys'];
      let bdd: { steps?: string[]; fallback?: boolean; language?: string } | undefined;
      let variables: string[] = [];
      const bddScopes: Array<{ dir: string; steps: string[] }> = [];
      const hasConfig = o.config || ['eztest.config.yaml', 'eztest.config.yml', 'eztest.config.json'].some((f) => existsSync(resolve(io.cwd, f)));
      if (hasConfig) {
        const loaded = await load(o);
        const c = loaded.config;
        cfgLint = c.lint;
        defaults = defaultLintPaths(io.cwd, { journeysDir: c.journeysDir, featureDirs: featureDirsFrom(c) });
        bdd = { ...(c.bdd.steps?.length ? { steps: c.bdd.steps } : {}), fallback: c.bdd.fallback, language: c.bdd.language };
        variables = Object.keys(c.vars ?? {});
        // Each project's features bind to that project's step definitions (an app per project: docs/project-guide.md).
        for (const ov of Object.values((c.projects ?? {}) as Record<string, { journeysDir?: unknown; bdd?: { steps?: unknown } }>)) {
          if (typeof ov?.journeysDir === 'string' && Array.isArray(ov.bdd?.steps)) bddScopes.push({ dir: ov.journeysDir, steps: ov.bdd.steps.map(String) });
        }
      } else defaults = defaultLintPaths(io.cwd);
      for (const name of Object.keys(cfgLint.rules)) {
        if (!(name in LINT_RULES)) io.err(`warning: lint.rules.${name}: unknown lint rule (rules: ${Object.keys(LINT_RULES).join(', ')})`);
      }
      const rules = { ...cfgLint.rules, ...(o.rule ?? {}) } as Partial<Record<LintRule, LintSeverity | 'off'>>;
      const report = await lintPaths(paths.length ? paths : defaults, { cwd: io.cwd, rules, variables, bddScopes, ...(bdd ? { bdd } : {}), ...(o.translated || cfgLint.translatedUi ? { translatedUi: true } : {}) });
      const text = o.format === 'json' ? JSON.stringify(report, null, 2) : o.format === 'sarif' ? formatSarif(report) : o.format === 'junit' ? formatJunit(report) : formatText(report);
      if (o.output) {
        await writeFile(resolve(io.cwd, o.output), text);
        io.out(`${report.counts.error} error(s), ${report.counts.warning} warning(s), ${report.counts.info} info; report: ${o.output}`);
      } else io.out(text);
      process.exitCode = lintExitCode(report, o.maxWarnings ?? cfgLint.maxWarnings);
    });
}
