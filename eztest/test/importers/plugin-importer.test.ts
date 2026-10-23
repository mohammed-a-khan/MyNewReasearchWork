/**
 * Importer plugins: a sample importer for an invented "acme-steps" format is
 * registered through the plugin API, then used by `importFiles`, by
 * `eztest import --from` (loaded with --plugin and from importers.plugins in
 * config) and by Studio's import page.
 */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importFiles, importFormats, importGherkin, importReportMarkdown } from '../../src/importers/index.js';
import { loadPlugins, registries, type LoadedPlugins } from '../../src/plugins/index.js';
import { startStudio } from '../../src/studio/index.js';
import { cli } from '../sdk/helpers.js';

const url = (...p: string[]) => JSON.stringify(pathToFileURL(join(process.cwd(), 'src', ...p)).href);

/** The sample importer: `step:` lines are EZ actions, `check:` lines assertions, anything else a TODO. */
const ACME_STEPS = `
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { definePlugin } from ${url('plugins', 'index.ts')};
import { JourneyDraft, assembleReport } from ${url('importers', 'index.ts')};

async function files(p) {
  if (!(await stat(p)).isDirectory()) return [p];
  const out = [];
  for (const e of (await readdir(p)).sort()) out.push(...(await files(join(p, e))));
  return out.filter((f) => f.endsWith('.acme'));
}

export default definePlugin({
  name: '@acme/eztest-importer-steps',
  version: '0.1.0',
  apiVersion: 1,
  setup(api) {
    api.registerImporter({
      name: 'acme-steps',
      title: 'ACME step files',
      extensions: ['.acme'],
      detect: async (paths) => (await Promise.all(paths.map(files))).flat().length > 0,
      async import(paths, ctx) {
        const drafts = [];
        const all = (await Promise.all(paths.map(files))).flat();
        for (const path of all) {
          const file = relative(ctx.cwd, path);
          let d;
          (await readFile(path, 'utf8')).split('\\n').forEach((raw, i) => {
            const line = raw.trim();
            const src = { line: i + 1, original: line };
            const m = /^(journey|step|check):\\s*(.*)$/.exec(line);
            if (!line || line.startsWith('#')) return;
            if (m && m[1] === 'journey') {
              const tags = [...(ctx.tags ?? []), ...(ctx.options.tag ? [String(ctx.options.tag)] : [])];
              d = new JourneyDraft(m[2], { kind: 'acme-steps', file, line: i + 1, ids: ctx.ids, tags });
              drafts.push(d);
            } else if (!d) return;
            else if (m) d.english(m[2], src, m[1] === 'check');
            else d.addTodo(src, 'not an acme-steps line');
          });
        }
        const report = assembleReport(drafts, all.map((f) => relative(ctx.cwd, f)), []);
        report.summary = { acme: { files: all.length, strict: ctx.options.strict === true } };
        report.markdown = ['## ACME step files', '', 'Files read: ' + all.length];
        return report;
      },
    });
  },
});
`;

const SUITE = [
  '# ACME steps v1',
  'journey: Sign in',
  'step: Open /login',
  'step: Click the "Sign in" button',
  'check: the page shows "Welcome"',
  'frobnicate the widget',
  '',
].join('\n');

async function project(extra: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ez-importer-plugin-'));
  const files = { 'importers/acme-steps.mjs': ACME_STEPS, 'suite/login.acme': SUITE, ...extra };
  for (const [f, text] of Object.entries(files)) {
    await mkdir(join(dir, f, '..'), { recursive: true });
    await writeFile(join(dir, f), text);
  }
  return dir;
}

let loaded: LoadedPlugins | undefined;
afterEach(() => {
  loaded?.off();
  loaded = undefined;
});

describe('importer plugins (API)', () => {
  it('registers a format that importFiles uses by name, by detection, and with options', async () => {
    const dir = await project();
    loaded = await loadPlugins(['./importers/acme-steps.mjs'], { cwd: dir });
    expect(registries.importers.names()).toEqual(['acme-steps']);
    expect(importFormats().find((f) => f.name === 'acme-steps')).toEqual({ name: 'acme-steps', title: 'ACME step files', plugin: true, extensions: ['.acme'] });
    expect(importFormats().filter((f) => !f.plugin).map((f) => f.name)).toContain('gherkin');

    const r = await importFiles([join(dir, 'suite')], { from: 'acme-steps', cwd: dir, tags: ['imported'], importerOptions: { strict: true, tag: 'acme' } });
    expect(r.converted.map((c) => [c.name, c.kind])).toEqual([['Sign in', 'acme-steps']]);
    expect(r.journeys[0].tags).toEqual(expect.arrayContaining(['imported', 'acme']));
    expect(r.coverage).toMatchObject({ sourceSteps: 3, convertedSteps: 2, assertions: 1, convertedAssertions: 1 });
    expect(r.todo.map((t) => t.reason)).toEqual(['not an acme-steps line']);
    expect(r.summary).toEqual({ acme: { files: 1, strict: true } });
    expect(importReportMarkdown(r)).toContain('## ACME step files');

    // Detection: with no --kind / --from, a plugin that claims the paths imports them.
    const auto = await importFiles([join(dir, 'suite')], { cwd: dir });
    expect(auto.converted[0].kind).toBe('acme-steps');
    // --kind with a plugin's name works too; a built-in name in --from is the built-in importer.
    expect((await importFiles([join(dir, 'suite')], { kind: 'acme-steps', cwd: dir })).converted[0].kind).toBe('acme-steps');
    await writeFile(join(dir, 'login.feature'), 'Feature: F\n  Scenario: S\n    Given I open "/"\n');
    expect((await importFiles([join(dir, 'login.feature')], { from: 'gherkin', cwd: dir })).converted[0].kind).toBe('gherkin');
  });

  it('refuses unknown formats with the list of known ones, and plugins that reuse a built-in name', async () => {
    const dir = await project();
    await expect(importFiles([join(dir, 'suite')], { from: 'nope', cwd: dir })).rejects.toThrow(/no importer "nope" \(known: gherkin, .*\).*importers\.plugins/);
    await writeFile(join(dir, 'bad.mjs'), `import { definePlugin } from ${url('plugins', 'index.ts')};
export default definePlugin({ name: 'bad', apiVersion: 1, setup(api) { api.registerImporter({ name: 'gherkin', import: () => ({}) }); } });`);
    await expect(loadPlugins(['./bad.mjs'], { cwd: dir })).rejects.toThrow(/"gherkin" is a built-in import format/);
    expect(registries.importers.names()).toEqual([]);
  });
});

describe('Gherkin externalExamples hook (for importers of Cucumber dialects)', () => {
  const feature = [
    'Feature: Shelves',
    '  @source:shelves.csv',
    '  Scenario Outline: Open <shelf>',
    '    When I click "<shelf>"',
    '    Examples: rows of pots.csv where kind = pan',
    '    Examples:',
    '      | shelf |',
    '      | Cups  |',
    '  Scenario Outline: Broken',
    '    When I click "<x>"',
    '    Examples: rows of ???',
    '',
  ].join('\n');

  it('turns tags and table-less Examples into Examples: from data, keeping tables as they are', () => {
    const diagnostics: Array<{ kind: string; message: string }> = [];
    const r = importGherkin(feature, {
      file: 'shelves.feature',
      diagnostics: diagnostics as never,
      externalExamples: ({ text, tag, file, line }) => {
        if (tag) return /^source:(.+)$/.test(text) ? { source: { from: text.slice(7) }, columns: ['shelf'] } : undefined;
        const m = /^rows of (\S+)(?: where (.+))?$/.exec(text);
        if (!m) return undefined;
        if (m[1] === '???') return { malformed: 'no file name', diagnostics: [{ kind: 'missing-data-file', file, line, message: 'which file?' }] };
        return { source: { from: m[1], ...(m[2] ? { where: m[2] } : {}) }, columns: ['shelf', 'kind'] };
      },
    });
    const ez = r.converted.map((c) => c.ez);
    expect(ez[0]).toContain('Examples: from data "shelves.csv"');
    expect(ez[0]).not.toMatch(/^Tags: .*source/m);
    expect(ez[1]).toContain('Examples: from data "pots.csv" where kind = pan');
    expect(r.converted[2].name).toMatch(/Cups/);
    expect(r.converted[3].journey).toBeUndefined();
    expect(diagnostics.map((d) => d.kind)).toEqual(['malformed-examples', 'missing-data-file']);
    expect(r.warnings.join('\n')).toMatch(/Scenario Outline "Broken" has no Examples rows \(Examples at line 11: which file\?\)/);
  });

  it('leaves table-less Examples without rows when no hook is given', () => {
    const r = importGherkin(feature, { file: 'shelves.feature' });
    expect(r.converted.map((c) => c.name)).toEqual(['Shelves - Open Cups', 'Shelves - Broken']);
    expect(r.journeys[0].tags).toContain('source:shelves.csv');
  });
});

describe('eztest import --from (CLI)', () => {
  it('loads the importer with --plugin and passes --importer-option values', async () => {
    const dir = await project();
    const r = await cli(dir, ['import', 'suite', '--plugin', './importers/acme-steps.mjs', '--from', 'acme-steps', '--importer-option', 'strict', '--importer-option', 'tag=acme', '-o', 'out']);
    expect(r.err).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(r.out.join('\n')).toContain('steps converted 2/3, assertions converted 1/1, 1 TODO line(s)');
    const ez = await readFile(join(dir, 'out', 'sign-in.ez'), 'utf8');
    expect(ez).toMatch(/^Journey: Sign in$/m);
    expect(ez).toMatch(/^Tags: .*acme/m);
    expect(ez).toContain('# TODO (not converted): frobnicate the widget');
    const json = JSON.parse(await readFile(join(dir, 'out', 'import-report.json'), 'utf8')) as { summary: unknown };
    expect(json.summary).toEqual({ acme: { files: 1, strict: true } });
    expect(await readFile(join(dir, 'out', 'import-report.md'), 'utf8')).toContain('Files read: 1');
    expect(registries.importers.names()).toEqual([]); // unloaded after the command
  });

  it('loads importers.plugins and importers.options from eztest.config.yaml', async () => {
    const dir = await project({
      'eztest.config.yaml': 'version: 1\nbaseUrl: http://127.0.0.1:9\nimporters:\n  plugins: [./importers/acme-steps.mjs]\n  options:\n    acme-steps: { strict: true }\n',
    });
    const r = await cli(dir, ['import', 'suite', '--from', 'acme-steps', '-o', 'out']);
    expect(r.err).toEqual([]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(await readFile(join(dir, 'out', 'import-report.json'), 'utf8')) as { summary: unknown };
    expect(json.summary).toEqual({ acme: { files: 1, strict: true } });
    const unknown = await cli(dir, ['import', 'suite', '--from', 'nope', '-o', 'out2']).catch((e: Error) => e);
    expect(String(unknown instanceof Error ? unknown.message : '')).toMatch(/no importer "nope" \(known: .*acme-steps/);
  });
});

describe("Studio's import page", () => {
  it('lists plugin formats and imports with them', async () => {
    const dir = await project();
    loaded = await loadPlugins(['./importers/acme-steps.mjs'], { cwd: dir });
    const token = 't'.repeat(64);
    const studio = await startStudio({ cwd: dir, token, watch: false });
    try {
      const headers = { 'x-eztest-token': token, 'content-type': 'application/json' };
      const formats = (await (await fetch(`${studio.origin}/api/import/formats`, { headers })).json()) as { formats: Array<{ name: string; plugin: boolean }> };
      expect(formats.formats.filter((f) => f.plugin).map((f) => f.name)).toEqual(['acme-steps']);
      expect(formats.formats.map((f) => f.name)).toContain('gherkin');
      const fs = (await (await fetch(`${studio.origin}/api/fs?dir=suite`, { headers })).json()) as { entries: Array<{ name: string; importable: boolean }> };
      expect(fs.entries).toEqual([expect.objectContaining({ name: 'login.acme', importable: true })]);
      const preview = await fetch(`${studio.origin}/api/import/preview`, { method: 'POST', headers, body: JSON.stringify({ paths: ['suite'], kind: 'acme-steps' }) });
      expect(preview.status).toBe(200);
      const p = (await preview.json()) as { journeys: Array<{ kind: string; ez: string }> };
      expect(p.journeys[0].kind).toBe('acme-steps');
      expect(p.journeys[0].ez).toMatch(/Journey: Sign in/);
      const write = await fetch(`${studio.origin}/api/import/write`, { method: 'POST', headers, body: JSON.stringify({ paths: ['suite'], kind: 'acme-steps', outDir: 'journeys/imported' }) });
      expect(write.status).toBe(200);
      expect(existsSync(join(dir, 'journeys', 'imported', 'sign-in.ez'))).toBe(true);
    } finally {
      await studio.close();
    }
  });
});
