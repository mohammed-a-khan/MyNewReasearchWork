/** `eztest lint`: anti-patterns in journeys and imported code, with fixes; CI friendly. */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Option, type Command } from 'commander';
import type { LoadedConfig } from '../config/index.js';
import { formatSarif, formatText, LINT_RULES, lintExitCode, lintPaths, type LintRule, type LintSeverity } from '../lint/index.js';

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
    .description('find hard waits, absolute/positional XPath, text-only locators, unchecked state changes and plain-text secrets in journeys and code')
    .argument('[paths...]', 'journey files, code files or directories (default: journeysDir from config)')
    .option('-c, --config <file>', 'config file')
    .option('-e, --env <name>', 'environment name')
    .option('--project <name>', 'project overlay')
    .addOption(new Option('-f, --format <format>', 'output format').choices(['text', 'json', 'sarif']).default('text'))
    .option('-o, --output <file>', 'write the report to a file (e.g. for code scanning)')
    .option('--max-warnings <n>', 'fail when there are more warnings than this', (v) => parseInt(v, 10))
    .option('--translated', 'the UI is translated: report text-only locators')
    .option('--rule <name=severity>', 'override a rule severity (repeatable)', ruleOverride)
    .action(async (paths: string[], o: { config?: string; env?: string; project?: string; format: string; output?: string; maxWarnings?: number; translated?: boolean; rule?: Record<string, string> }) => {
      let cfgLint: { translatedUi: boolean; rules: Record<string, string>; maxWarnings?: number } = { translatedUi: false, rules: {} };
      let journeysDir = 'journeys';
      const hasConfig = o.config || ['eztest.config.yaml', 'eztest.config.yml', 'eztest.config.json'].some((f) => existsSync(resolve(io.cwd, f)));
      if (hasConfig) {
        const loaded = await load(o);
        cfgLint = loaded.config.lint;
        journeysDir = loaded.config.journeysDir;
      }
      const rules = { ...cfgLint.rules, ...(o.rule ?? {}) } as Partial<Record<LintRule, LintSeverity | 'off'>>;
      const report = await lintPaths(paths.length ? paths : [journeysDir], { cwd: io.cwd, rules, ...(o.translated || cfgLint.translatedUi ? { translatedUi: true } : {}) });
      const text = o.format === 'json' ? JSON.stringify(report, null, 2) : o.format === 'sarif' ? formatSarif(report) : formatText(report);
      if (o.output) {
        await writeFile(resolve(io.cwd, o.output), text);
        io.out(`${report.counts.error} error(s), ${report.counts.warning} warning(s), ${report.counts.info} info; report: ${o.output}`);
      } else io.out(text);
      process.exitCode = lintExitCode(report, o.maxWarnings ?? cfgLint.maxWarnings);
    });
}
