/** Project file picker and the Migration Factory (import preview and write). */
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative } from 'node:path';
import { importFiles, importFormats, importerPlugins, writeImported, coverageEquivalence, type ImportKind } from '../../importers/index.js';
import { HttpError, sendError, sendJson, str, strList } from '../http.js';
import { JOURNEY_EXTENSIONS, PathError, isSensitive, relPosix } from '../security.js';
import type { StudioRoute, StudioRouteContext } from './route.js';

const IMPORT_KINDS: ImportKind[] = ['gherkin', 'playwright', 'selenium', 'manual-csv', 'manual-xlsx', 'task-recorder'];
const IMPORTABLE = new Set(['.feature', '.ts', '.js', '.mjs', '.cjs', '.java', '.cs', '.py', '.csv', '.xlsx', '.xml']);

/** File extensions the picker allows: the built-in importers' and those importer plugins declare. */
function importable(ext: string): boolean {
  return IMPORTABLE.has(ext) || importerPlugins().some((p) => p.extensions?.map((e) => e.toLowerCase()).includes(ext));
}

async function runImport({ res, app, body, url }: StudioRouteContext): Promise<void> {
  const cwd = app.cwd;
  const paths = strList(body.paths) ?? [];
  if (!paths.length) throw new HttpError(400, 'Choose at least one file or folder to import');
  const abs = paths.map((p) => {
    const a = app.confine(p);
    if (isSensitive(relPosix(cwd, a))) throw new PathError(`Not importable: ${p}`);
    if (!existsSync(a)) throw new HttpError(404, `Not found: ${p}`);
    return a;
  });
  const kind = body.kind === undefined || body.kind === '' ? undefined : String(body.kind);
  const plugin = kind !== undefined && importerPlugins().some((p) => p.name === kind);
  if (kind !== undefined && !plugin && !IMPORT_KINDS.includes(kind as ImportKind)) throw new HttpError(400, `Unknown import kind "${kind}"`);
  let report;
  try {
    const mode = body.mode === 'manual' || body.mode === 'hybrid' ? body.mode : undefined;
    const outDir = typeof body.outDir === 'string' && body.outDir.trim() ? body.outDir.trim() : undefined;
    report = await importFiles(abs, {
      ...(plugin ? { from: kind } : { kind: kind as ImportKind | undefined }), tags: strList(body.tags), cwd, ...(mode ? { manualMode: mode } : {}), ...(outDir ? { outDir } : {}),
    });
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
  const eq = coverageEquivalence(report);
  const preview = {
    files: report.files,
    coverage: report.coverage,
    ratios: eq.ratios,
    warnings: report.warnings,
    todo: report.todo,
    journeys: report.converted.map((c) => ({ id: c.id, name: c.name, kind: c.kind, file: c.file, line: c.line, ez: c.ez, runnable: !!c.journey, todo: c.todo.length, coverage: c.coverage })),
  };
  if (url.pathname === '/api/import/preview') return sendJson(res, 200, preview);
  const outRel = str(body.outDir, 'outDir');
  const outAbs = app.confine(outRel);
  const outRelPosix = relPosix(cwd, outAbs);
  if (!outRelPosix || isSensitive(outRelPosix)) throw new PathError('Choose a folder inside the project, e.g. journeys/imported');
  const resultsDir = await app.outputDir();
  const r2 = relative(resultsDir, outAbs);
  if (r2 === '' || (!r2.startsWith('..') && !isAbsolute(r2))) throw new PathError('Cannot write into the results directory');
  const written = await writeImported(report, outAbs);
  sendJson(res, 200, {
    ...preview,
    written: {
      ezFiles: written.ezFiles.map((f) => relPosix(cwd, f)),
      unconvertedFiles: written.unconvertedFiles.map((f) => relPosix(cwd, f)),
      reportMd: relPosix(cwd, written.reportMd),
      reportJson: relPosix(cwd, written.reportJson),
    },
  });
}

export const importRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/fs',
    summary: 'List a project folder (sensitive files hidden)',
    async handler({ res, app, query }) {
      const cwd = app.cwd;
      const dirParam = query.get('dir') || '.';
      const abs = dirParam === '.' ? cwd : app.confine(dirParam);
      const rel = relPosix(cwd, abs);
      if (rel && isSensitive(rel)) throw new PathError('This folder is not available');
      if (!existsSync(abs) || !(await stat(abs)).isDirectory()) return sendError(res, 404, 'Folder not found');
      const entries: Array<{ name: string; path: string; type: 'dir' | 'file'; importable?: boolean; journey?: boolean }> = [];
      for (const d of (await readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = rel ? `${rel}/${d.name}` : d.name;
        if (isSensitive(p)) continue;
        if (d.isDirectory()) entries.push({ name: d.name, path: p, type: 'dir' });
        else if (d.isFile()) {
          const ext = extname(d.name).toLowerCase();
          entries.push({ name: d.name, path: p, type: 'file', importable: importable(ext), journey: JOURNEY_EXTENSIONS.has(ext) });
        }
      }
      sendJson(res, 200, { dir: rel || '.', parent: rel ? relPosix(cwd, dirname(abs)) || '.' : undefined, entries });
    },
  },
  {
    method: 'GET',
    path: '/api/import/formats',
    summary: 'Import formats: the built-in ones the page offers, then those importer plugins add',
    async handler({ res }) {
      const builtin = new Set<string>(IMPORT_KINDS);
      sendJson(res, 200, { formats: importFormats().filter((f) => f.plugin || builtin.has(f.name)) });
    },
  },
  { method: 'POST', path: '/api/import/preview', summary: 'Convert tests to journeys (preview)', handler: runImport },
  { method: 'POST', path: '/api/import/write', summary: 'Convert tests and write the journeys', handler: runImport },
];
