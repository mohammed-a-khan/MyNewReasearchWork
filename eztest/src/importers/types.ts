/**
 * Shared types for the Migration Factory: every importer turns another tool's
 * tests into EZTest journeys and reports exactly what it could not convert.
 */
import type { Journey } from '../core/index.js';

/** Source formats the built-in importers understand. */
export type BuiltinImportKind = 'gherkin' | 'playwright' | 'selenium' | 'manual-csv' | 'manual-xlsx' | 'task-recorder' | 'openapi' | 'postman' | 'wsdl' | 'ado-test-plans';

/** The built-in formats `eztest import --kind` accepts (ADO test plans are imported by `eztest ado`). */
export const BUILTIN_IMPORT_KINDS: readonly BuiltinImportKind[] = ['gherkin', 'playwright', 'selenium', 'manual-csv', 'manual-xlsx', 'task-recorder', 'openapi', 'postman', 'wsdl'];

/** A built-in format, or the name of a format an importer plugin registers (docs/plugins.md). */
export type ImportKind = BuiltinImportKind | (string & {});

/** A source step or assertion that was not converted. It is also kept as a `# TODO (not converted): ...` line in the .ez. */
export interface TodoItem {
  file: string;
  /** 1-based line (or spreadsheet row) in the source. */
  line: number;
  /** The original source text, whitespace-collapsed to one line. */
  original: string;
  reason: string;
  /** Journey the item belongs to (absent for file-level items). */
  journeyId?: string;
}

/** Conversion counts. Assertions are counted separately from action steps. */
export interface ImportCoverage {
  /** Source action steps seen. */
  sourceSteps: number;
  /** Source action steps converted to journey steps. */
  convertedSteps: number;
  /** Source assertions/expectations seen. */
  assertions: number;
  /** Source assertions converted to post-conditions or assert steps. */
  convertedAssertions: number;
}

/** One imported test. `journey` is absent when nothing in it could be converted. */
export interface ConvertedJourney {
  id: string;
  name: string;
  kind: ImportKind;
  file: string;
  /** Source line where the test starts. */
  line: number;
  /** The generated .ez script (TODO lines included). */
  ez: string;
  journey?: Journey;
  coverage: ImportCoverage;
  todo: TodoItem[];
  /** Always false from an importer: only a real run (`verifyImported`) can verify a conversion. */
  verified: false;
}

export interface ImportReport {
  /** Runnable journeys (one per converted test that has at least one step). */
  journeys: Journey[];
  /** Every imported test, including ones with no convertible steps. */
  converted: ConvertedJourney[];
  todo: TodoItem[];
  warnings: string[];
  coverage: ImportCoverage;
  /** Source files read. */
  files: string[];
  /** Problems found in the source suite itself (missing data files, undefined or duplicate steps, ...). */
  diagnostics?: SourceDiagnostic[];
  /** Extra files to write next to the journeys (e.g. converted payload templates), paths relative to the output directory. */
  assets?: Array<{ path: string; content: string }>;
  /** Importer-specific summary (e.g. statistics of a plugin importer), kept in import-report.json. */
  summary?: Record<string, unknown>;
  /** Extra Markdown lines an importer adds to import-report.md (after the TODO and needs-work sections). */
  markdown?: string[];
}

/** A problem in the source suite found while importing. */
export interface SourceDiagnostic {
  kind: string;
  file: string;
  line: number;
  message: string;
}

/** Options shared by all importers. */
export interface ImporterOptions {
  /** File name used in reports and TODO items. */
  file?: string;
  /** Journey ids already taken (shared across files by `importFiles`); new ids get a numeric suffix. */
  ids?: Set<string>;
  /** Tags added to every imported journey. */
  tags?: string[];
}

/** What `eztest import` (or Studio) hands an importer plugin. */
export interface ImporterContext {
  /** Project directory; shorten file names in reports relative to it. */
  cwd: string;
  /** Output directory relative to cwd (journeys are written there; generated assets are referenced from it). */
  outDir?: string;
  /** Tags to add to every imported journey. */
  tags?: string[];
  /** Journey ids already taken; new ids get a numeric suffix. */
  ids: Set<string>;
  /** Importer-specific options: `--importer-option key=value` on the CLI (a bare `key` is true), `options` in config. */
  options: Record<string, string | boolean>;
}

/**
 * A source format added by a plugin (`api.registerImporter`, docs/plugins.md): it appears in
 * `eztest import --from <name>` and in Studio's import page.
 */
export interface ImporterPlugin {
  /** Format name, e.g. "acme-steps": `eztest import --from acme-steps`. Must not be a built-in kind. */
  name: string;
  /** Label in Studio's format list (default: the name). */
  title?: string;
  description?: string;
  /** File extensions this importer reads (lower case, with the dot); Studio lets users pick such files. */
  extensions?: string[];
  /** Claim a set of paths during automatic detection (no --kind / --from). Plugins are asked before the built-in importers. */
  detect?(paths: string[]): boolean | Promise<boolean>;
  /** Convert the files (directories are the importer's to walk) into a report; EZTest writes the journeys. */
  import(paths: string[], ctx: ImporterContext): ImportReport | Promise<ImportReport>;
}

export function emptyCoverage(): ImportCoverage {
  return { sourceSteps: 0, convertedSteps: 0, assertions: 0, convertedAssertions: 0 };
}

export function addCoverage(a: ImportCoverage, b: ImportCoverage): ImportCoverage {
  return {
    sourceSteps: a.sourceSteps + b.sourceSteps,
    convertedSteps: a.convertedSteps + b.convertedSteps,
    assertions: a.assertions + b.assertions,
    convertedAssertions: a.convertedAssertions + b.convertedAssertions,
  };
}
