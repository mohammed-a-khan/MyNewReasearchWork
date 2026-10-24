/**
 * `importFiles`: detect each file's format and run the right importer;
 * `writeImported`: write `.ez` files plus `import-report.json` / `.md`.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { importGherkin } from './gherkin.js';
import { importManualCsv, importManualXlsx, type ManualColumns } from './manual.js';
import { importPlaywright } from './playwright.js';
import { mergeReports } from './report.js';
import { importSelenium } from './selenium.js';
import { importTaskRecorder, type TaskRecorderOptions } from './task-recorder.js';
import { BUILTIN_IMPORT_KINDS, type ImportKind, type ImportReport, type ImporterPlugin } from './types.js';
import { registries } from '../plugins/registry.js';
import { importApiFile, isApiSpecPath } from './api-files.js';
import { importWsdl, looksLikeWsdl } from './wsdl.js';
import { coverageEquivalence, verifiedRunOf, type ImportVerification } from './verify.js';
import { credentialsMarkdown, scrubJourney, scrubText, type CredentialFinding } from './credentials.js';

export interface ImportFilesOptions {
  /** Force one format for every file (default: detect per file). A plugin importer's name works too. */
  kind?: ImportKind;
  /** Use this importer plugin (its registered name) for the whole import; see docs/plugins.md. */
  from?: string;
  /** Options for an importer plugin (`--importer-option key=value`). */
  importerOptions?: Record<string, string | boolean>;
  /** Column names for manual CSV/XLSX imports. */
  columns?: ManualColumns;
  /** Manual CSV/XLSX: keep cases manual (`Manual:` steps) or hybrid instead of TODO lines (docs/manual-testing.md). */
  manualMode?: 'automated' | 'manual' | 'hybrid';
  /** Worksheet for XLSX imports. */
  sheet?: string | number;
  /** Tags added to every imported journey. */
  tags?: string[];
  /** Task Recorder options (menu item URLs, company). */
  taskRecorder?: Pick<TaskRecorderOptions, 'menuItemUrl' | 'company'>;
  /** Base directory used to shorten file names in reports. Default: process.cwd(). */
  cwd?: string;
  /** Output directory relative to cwd (generated files such as payload templates are referenced from it). */
  outDir?: string;
  /** OpenAPI: Identity Vault role for secured operations. */
  role?: string;
  /** Postman: an environment export file (its non-secret values become Variables). */
  postmanEnvironment?: string;
}

/** Importer plugins currently registered (loaded from `importers.plugins` / `plugins` in config, or `eztest import --plugin`). */
export function importerPlugins(): ImporterPlugin[] {
  return registries.importers.list();
}

/** The formats `eztest import --from` and Studio offer: the built-in kinds, then the plugin importers. */
export function importFormats(): Array<{ name: string; title: string; plugin: boolean; extensions?: string[] }> {
  const titles: Record<string, string> = {
    gherkin: 'Cucumber / Gherkin', playwright: 'Playwright', selenium: 'Selenium', 'manual-csv': 'Manual cases (CSV)', 'manual-xlsx': 'Manual cases (Excel)',
    'task-recorder': 'D365 Task Recorder', openapi: 'OpenAPI / Swagger', postman: 'Postman collection', wsdl: 'WSDL (SOAP)',
  };
  return [
    ...BUILTIN_IMPORT_KINDS.map((k) => ({ name: k, title: titles[k] ?? k, plugin: false })),
    ...importerPlugins().map((p) => ({ name: p.name, title: p.title ?? p.name, plugin: true, ...(p.extensions ? { extensions: p.extensions } : {}) })),
  ];
}

async function runPlugin(p: ImporterPlugin, paths: string[], opts: ImportFilesOptions): Promise<ImportReport> {
  return p.import(paths, {
    cwd: opts.cwd ?? process.cwd(), ids: new Set<string>(), options: { ...(opts.importerOptions ?? {}) },
    ...(opts.outDir ? { outDir: opts.outDir } : {}), ...(opts.tags ? { tags: opts.tags } : {}),
  });
}

const EXTS = ['.feature', '.ts', '.js', '.mjs', '.cjs', '.java', '.cs', '.py', '.csv', '.xlsx', '.xml', '.json', '.yaml', '.yml', '.wsdl'];

/** Detect an importer from the file name and (for ambiguous extensions) its content. */
export function detectImportKind(path: string, content?: string): ImportKind | undefined {
  const ext = extname(path).toLowerCase();
  if (ext === '.feature') return 'gherkin';
  if (ext === '.wsdl') return 'wsdl';
  if (ext === '.csv') return 'manual-csv';
  if (ext === '.xlsx') return 'manual-xlsx';
  if (ext === '.java' || ext === '.cs') return 'selenium';
  if (ext === '.py') return content === undefined || /selenium|webdriver/i.test(content) ? 'selenium' : undefined;
  if (['.ts', '.js', '.mjs', '.cjs'].includes(ext)) {
    if (content === undefined) return /\.(?:spec|test)\.[cm]?[jt]s$/i.test(path) ? 'playwright' : undefined;
    return /@playwright\/test|\bpage\.(?:goto|getBy|locator)\b/.test(content) ? 'playwright' : undefined;
  }
  if (ext === '.xml') {
    if (content !== undefined && looksLikeWsdl(content)) return 'wsdl';
    if (content === undefined) return 'task-recorder';
    return /<(?:\w+:)?(?:Recording|TaskRecording|UserAction|Node)\b|MenuItemName|ControlLabel/.test(content) ? 'task-recorder' : undefined;
  }
  return undefined;
}

async function expand(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    if (!(await stat(p)).isDirectory()) {
      out.push(p);
      continue;
    }
    const entries = (await readdir(p, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(p, e.name);
      if (e.isDirectory()) out.push(...(await expand([full])));
      else if (EXTS.includes(extname(e.name).toLowerCase())) out.push(full);
    }
  }
  return out;
}

/** Import test files of any supported format (directories are searched recursively). */
export async function importFiles(paths: string[], opts: ImportFilesOptions = {}): Promise<ImportReport> {
  // An importer plugin takes the whole set of paths: named with --from (or --kind), or claiming them on detection.
  const named = opts.from ?? (opts.kind !== undefined && !(BUILTIN_IMPORT_KINDS as readonly string[]).includes(opts.kind) ? opts.kind : undefined);
  if (named !== undefined) {
    if ((BUILTIN_IMPORT_KINDS as readonly string[]).includes(named)) return importFiles(paths, { ...opts, from: undefined, kind: named });
    const p = registries.importers.get(named);
    if (!p) {
      const known = importFormats().map((f) => f.name).join(', ');
      throw new Error(`importFiles: no importer "${named}" (known: ${known}). Importer plugins are loaded from importers.plugins in eztest.config.yaml or with --plugin`);
    }
    return runPlugin(p, paths, opts);
  }
  if (opts.kind === undefined) {
    for (const p of importerPlugins()) if (p.detect && (await p.detect(paths))) return runPlugin(p, paths, opts);
  }
  const ids = new Set<string>();
  const reports: ImportReport[] = [];
  const cwd = opts.cwd ?? process.cwd();
  const files = await expand(paths);
  if (!files.length) throw new Error('importFiles: no files to import');
  for (const path of files) {
    const abs = resolve(path);
    const rel = relative(cwd, abs);
    const file = rel && !rel.startsWith('..') ? rel : abs;
    const ext = extname(path).toLowerCase();
    const text = ext === '.xlsx' ? undefined : await readFile(path, 'utf8');
    // OpenAPI/Swagger specs and Postman collections (JSON/YAML); other JSON/YAML files in a directory are not tests.
    if (opts.kind === 'openapi' || opts.kind === 'postman' || (opts.kind === undefined && isApiSpecPath(path))) {
      const r = await importApiFile(path, text!, { file, ids, cwd, kind: opts.kind, explicit: paths.some((p) => resolve(p) === abs), ...(opts.tags ? { tags: opts.tags } : {}), ...(opts.role ? { role: opts.role } : {}), ...(opts.postmanEnvironment ? { environment: opts.postmanEnvironment } : {}) });
      if (r) reports.push(r);
      continue;
    }
    const kind = opts.kind ?? detectImportKind(path, text);
    const base = { file, ids, ...(opts.tags ? { tags: opts.tags } : {}) };
    if (!kind) {
      reports.push({ journeys: [], converted: [], todo: [], warnings: [`${file}: format not recognised; skipped`], coverage: { sourceSteps: 0, convertedSteps: 0, assertions: 0, convertedAssertions: 0 }, files: [file] });
      continue;
    }
    switch (kind) {
      case 'gherkin': reports.push(importGherkin(text!, base)); break;
      case 'playwright': reports.push(importPlaywright(text!, base)); break;
      case 'selenium': reports.push(importSelenium(text!, base)); break;
      case 'manual-csv': reports.push(importManualCsv(text!, { ...base, ...(opts.columns ? { columns: opts.columns } : {}), ...(opts.manualMode ? { manualMode: opts.manualMode } : {}) })); break;
      case 'manual-xlsx':
        reports.push(await importManualXlsx(path, { ...base, ...(opts.columns ? { columns: opts.columns } : {}), ...(opts.sheet !== undefined ? { sheet: opts.sheet } : {}), ...(opts.manualMode ? { manualMode: opts.manualMode } : {}) }));
        break;
      case 'task-recorder': reports.push(importTaskRecorder(text!, { ...base, ...(opts.taskRecorder ?? {}) })); break;
      case 'openapi': case 'postman': break; // handled above
      case 'wsdl': reports.push(await importWsdl({ ...base, absPath: abs, cwd, ...(opts.outDir ? { outDir: opts.outDir } : {}) })); break;
      default: reports.push({ journeys: [], converted: [], todo: [], warnings: [`${file}: no importer for format "${kind}"; skipped`], coverage: { sourceSteps: 0, convertedSteps: 0, assertions: 0, convertedAssertions: 0 }, files: [file] });
    }
  }
  return mergeReports(reports);
}

function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}

function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Render the import report (and optional verification) as Markdown. */
export function importReportMarkdown(report: ImportReport, verification?: ImportVerification): string {
  const eq = coverageEquivalence(report, verification);
  const c = report.coverage;
  const out: string[] = [
    '# Import report', '',
    `Files: ${report.files.length} · Tests: ${report.converted.length} · Runnable journeys: ${report.journeys.length}`, '',
    '| | Source | Converted | Verified |', '|---|---|---|---|',
    `| Steps | ${c.sourceSteps} | ${c.convertedSteps} | ${verification ? eq.totals.verifiedSteps : 'not run'} |`,
    `| Assertions | ${c.assertions} | ${c.convertedAssertions} | ${verification ? eq.totals.verifiedAssertions : 'not run'} |`, '',
    `Converted: ${pct(eq.ratios.converted)}${verification ? ` · Verified by replay: ${pct(eq.ratios.verified)} (run ${verification.runId})` : ' · Not verified: run with --verify to replay the journeys'}`, '',
    '## Journeys', '', '| Journey | Source | Status | Steps | Assertions | TODO |', '|---|---|---|---|---|---|',
  ];
  for (const j of eq.journeys) {
    const cj = report.converted.find((x) => x.id === j.id)!;
    out.push(`| ${mdCell(j.name)} (\`${j.id}\`) | ${mdCell(`${cj.file}:${cj.line}`)} | ${j.status} | ${j.convertedSteps}/${j.sourceSteps} | ${j.convertedAssertions}/${j.assertions} | ${j.todo} |`);
  }
  if (report.todo.length) {
    out.push('', '## Not converted (TODO)', '', '| Location | Original | Reason |', '|---|---|---|');
    for (const t of report.todo) out.push(`| ${mdCell(`${t.file}:${t.line}`)} | \`${mdCell(t.original).replace(/`/g, "'")}\` | ${mdCell(t.reason)} |`);
  }
  if (eq.needsWork.length) out.push('', '## Needs work', '', ...eq.needsWork.map((n) => `- ${n}`));
  if (report.markdown?.length) out.push('', ...report.markdown);
  if (report.diagnostics?.length) {
    const by = new Map<string, number>();
    for (const d of report.diagnostics) by.set(d.kind, (by.get(d.kind) ?? 0) + 1);
    out.push('', '## Source-suite diagnostics', '', 'Problems in the source suite itself (they fail or mislead in the original framework too).', '',
      '| Kind | Count |', '|---|---|', ...[...by].map(([k, n]) => `| ${k} | ${n} |`), '',
      '| Kind | Location | Problem |', '|---|---|---|',
      ...report.diagnostics.map((d) => `| ${d.kind} | ${mdCell(`${d.file}:${d.line}`)} | ${mdCell(d.message)} |`));
  }
  if (report.warnings.length) out.push('', '## Warnings', '', ...report.warnings.map((w) => `- ${w}`));
  return out.join('\n') + '\n';
}

export interface WrittenImport {
  /** .ez files written (one per runnable journey). */
  ezFiles: string[];
  /** Tests with no convertible step, written as `<id>.unconverted.txt` (not picked up as journeys). */
  unconvertedFiles: string[];
  reportJson: string;
  reportMd: string;
}

/** Write generated support files (e.g. converted payload templates) into the output directory; `--verify` needs them before the run. */
export async function writeImportAssets(report: ImportReport, outDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const a of report.assets ?? []) {
    const path = join(outDir, a.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, a.content);
    out.push(path);
  }
  return out;
}

/**
 * Write `<id>.ez` per journey, plus `import-report.json` and `import-report.md`. Credential-like literals of the
 * source never reach these files: they become `${NAME}` variables, listed in the report (`credentials`) with a
 * secret:// hint (src/importers/credentials.ts). Verification (`verifyImported`) runs before this, on the source values.
 */
export async function writeImported(source: ImportReport, outDir: string, verification?: ImportVerification): Promise<WrittenImport> {
  await mkdir(outDir, { recursive: true });
  const names = new Map<string, string>();
  const credentials: CredentialFinding[] = [];
  const converted = source.converted.map((c) => {
    const s = scrubJourney(c, names);
    credentials.push(...s.findings);
    return { ...c, ez: s.ez, todo: s.todo };
  });
  const report: ImportReport = {
    ...source, converted,
    todo: source.todo.map((t) => ({ ...t, original: scrubText(t.original, names) })),
    warnings: source.warnings.map((w) => scrubText(w, names)),
    ...(credentials.length ? { markdown: [...(source.markdown ?? []), ...credentialsMarkdown(credentials)] } : {}),
  };
  const ezFiles: string[] = [];
  const unconvertedFiles: string[] = [];
  for (const c of report.converted) {
    const path = join(outDir, c.journey ? `${c.id}.ez` : `${c.id}.unconverted.txt`);
    // A journey that passed a real replay no longer needs its [unverified] markers.
    const replayed = verifiedRunOf(c.id, !!(c.journey?.examples?.length || c.journey?.examplesFrom), verification)?.verified;
    await writeFile(path, replayed ? c.ez.replace(/ \[unverified\]$/gm, '') : c.ez);
    (c.journey ? ezFiles : unconvertedFiles).push(path);
  }
  await writeImportAssets(report, outDir);
  const eq = coverageEquivalence(report, verification);
  const json = {
    files: report.files,
    coverage: report.coverage,
    ...(report.diagnostics ? { diagnostics: report.diagnostics } : {}),
    ...(report.summary ? { summary: report.summary } : {}),
    equivalence: eq,
    journeys: report.converted.map((c) => ({
      id: c.id, name: c.name, kind: c.kind, file: c.file, line: c.line, coverage: c.coverage, todo: c.todo.length,
      output: c.journey ? `${c.id}.ez` : `${c.id}.unconverted.txt`,
      verified: verifiedRunOf(c.id, !!(c.journey?.examples?.length || c.journey?.examplesFrom), verification)?.verified ?? false,
    })),
    todo: report.todo,
    ...(credentials.length ? { credentials } : {}),
    warnings: report.warnings,
    ...(verification ? { verification: { runId: verification.runId, summary: verification.summary, journeys: verification.journeys } } : {}),
  };
  const reportJson = join(outDir, 'import-report.json');
  const reportMd = join(outDir, 'import-report.md');
  await writeFile(reportJson, JSON.stringify(json, null, 2));
  await writeFile(reportMd, importReportMarkdown(report, verification));
  return { ezFiles, unconvertedFiles, reportJson, reportMd };
}
