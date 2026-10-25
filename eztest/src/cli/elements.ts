/**
 * `eztest elements list|unused|duplicates|import-screens`: the shared element
 * repository (docs/elements.md).
 *
 *   eztest elements list                 every element, its locators and how many journeys use it
 *   eztest elements unused               elements no journey and no code uses (exit 1 when there are some, with --strict)
 *   eztest elements duplicates           elements that look like the same element defined twice
 *   eztest elements import-screens [dir] write elements/<Screen>.yaml from TypeScript screens (e.g. screens/)
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { Command } from 'commander';
import type { LoadedConfig } from '../config/index.js';
import { duplicateElements, elementUsages } from '../elements/bind.js';
import { mergeUsages, projectCodeUsages } from '../elements/code-usages.js';
import { renderElementFile } from '../elements/render.js';
import { ElementRepository, screenId, type RepoElement } from '../elements/repository.js';
import { readScreenModule } from '../elements/screens.js';
import { describeCandidate } from '../runner/locate.js';
import { loadJourneys } from './journeys.js';

interface IO {
  out(s: string): void;
  err(s: string): void;
  cwd: string;
}

type Load = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;
type Opts = { config?: string; env?: string; project?: string; json?: boolean; strict?: boolean };

async function context(io: IO, load: Load, o: Opts) {
  const loaded = await load(o);
  const cfg = loaded.config;
  const repo = await ElementRepository.load(io.cwd, cfg.elements);
  const { journeys, errors } = await loadJourneys([cfg.journeysDir], io.cwd).catch(() => ({ journeys: [], errors: [] }));
  for (const e of [...repo.problems, ...errors]) io.err(`warning: ${e.file}: ${e.message}`);
  // Code journeys, step definitions and screens use elements too: screen model entries share the repository's ids.
  const usages = mergeUsages(elementUsages(journeys, repo), await projectCodeUsages(io.cwd, cfg, repo));
  return { cfg, repo, journeys, usages };
}

const common = (c: Command) => c.option('-c, --config <file>').option('-e, --env <name>').option('--project <name>', 'project overlay (projects.<name>)').option('--json', 'machine-readable output');

export function registerElementCommands(program: Command, io: IO, load: Load): void {
  const el = program.command('elements').description('the shared element repository (elements/*.yaml, screens)');

  common(el.command('list').description('list elements with their locators and usages')).action(async (o: Opts) => {
    const { repo, usages, cfg } = await context(io, load, o);
    const rows = repo.list().map((e) => ({ id: e.id, description: e.description, locators: e.locators.map(describeCandidate), file: `${e.file}${e.line ? `:${e.line}` : ''}`, usages: usages.get(e.id)?.length ?? 0, journeys: [...new Set((usages.get(e.id) ?? []).map((u) => u.journeyId))] }));
    if (o.json) return io.out(JSON.stringify(rows, null, 2));
    if (!rows.length) return io.out(`No elements (looked in ${cfg.elements.dir}/${cfg.elements.screens.length ? ` and ${cfg.elements.screens.join(', ')}` : ''}).`);
    for (const r of rows) {
      io.out(`@${r.id}  ${r.description}  (${r.usages} use${r.usages === 1 ? '' : 's'} in ${r.journeys.length} journey${r.journeys.length === 1 ? '' : 's'}; ${r.file})`);
      for (const l of r.locators) io.out(`    ${l}`);
    }
    io.out(`${rows.length} element${rows.length === 1 ? '' : 's'}`);
  });

  common(el.command('unused').description('elements no journey and no code uses').option('--strict', 'exit 1 when there are unused elements')).action(async (o: Opts) => {
    const { repo, usages } = await context(io, load, o);
    const unused = repo.list().filter((e) => !usages.get(e.id)?.length);
    const unknown = [...usages.keys()].filter((id) => !repo.get(id)).sort();
    if (o.json) io.out(JSON.stringify({ unused: unused.map((e) => ({ id: e.id, file: e.file, line: e.line })), unknown }, null, 2));
    else {
      for (const e of unused) io.out(`@${e.id}  ${e.file}${e.line ? `:${e.line}` : ''}`);
      for (const id of unknown) io.out(`unknown: @${id} is used by ${[...new Set(usages.get(id)!.map((u) => u.journeyName))].join(', ')} but is not in the repository`);
      io.out(`${unused.length} unused element${unused.length === 1 ? '' : 's'}${unknown.length ? `, ${unknown.length} unknown reference${unknown.length === 1 ? '' : 's'}` : ''}`);
    }
    if (unknown.length || (o.strict && unused.length)) process.exitCode = 1;
  });

  common(el.command('duplicates').description('elements that look like the same element defined twice').option('--strict', 'exit 1 when there are duplicates')).action(async (o: Opts) => {
    const { repo } = await context(io, load, o);
    const groups = duplicateElements(repo);
    if (o.json) io.out(JSON.stringify(groups, null, 2));
    else {
      const why: Record<string, string> = { 'same-locators': 'same locators', 'same-locator': 'same first locator', 'same-description': 'same description' };
      for (const g of groups) io.out(`${why[g.reason]}: ${g.ids.map((i) => `@${i}`).join(', ')}`);
      io.out(`${groups.length} duplicate group${groups.length === 1 ? '' : 's'}`);
    }
    if (o.strict && groups.length) process.exitCode = 1;
  });

  el.command('import-screens')
    .description('write elements/<Screen>.yaml from TypeScript screens (SDK screen() calls, e.g. in screens/); nothing is executed')
    .argument('[dirs...]', 'screen directories (default: screens)')
    .option('-c, --config <file>')
    .option('-e, --env <name>')
    .option('--project <name>')
    .option('--force', 'overwrite existing element files')
    .option('--dry-run', 'print what would be written')
    .action(async (dirs: string[], o: Opts & { force?: boolean; dryRun?: boolean }) => {
      const loaded = await load(o);
      const outDir = resolve(io.cwd, loaded.config.elements.dir);
      const byScreen = new Map<string, { screen: string; elements: RepoElement[]; files: Set<string> }>();
      let problems = 0;
      const { readdir, stat } = await import('node:fs/promises');
      const files: string[] = [];
      const walk = async (d: string) => {
        if (!existsSync(d)) return;
        for (const n of (await readdir(d)).sort()) {
          const p = join(d, n);
          if ((await stat(p)).isDirectory()) await walk(p);
          else if (/\.(?:ts|mts|js|mjs)$/.test(n)) files.push(p);
        }
      };
      for (const d of dirs.length ? dirs : ['screens']) await walk(resolve(io.cwd, d));
      if (!files.length) {
        io.err(`No screen modules found in ${(dirs.length ? dirs : ['screens']).join(', ')}`);
        process.exitCode = 1;
        return;
      }
      for (const f of files) {
        const rel = relative(io.cwd, f).split('\\').join('/');
        const r = await readScreenModule(await readFile(f, 'utf8'), rel);
        for (const p of r.problems) {
          io.err(`skipped: ${p.message}`);
          problems++;
        }
        for (const e of r.elements) {
          const g = byScreen.get(e.screen) ?? { screen: e.screen, elements: [], files: new Set<string>() };
          if (!g.elements.some((x) => x.key === e.key)) g.elements.push(e);
          g.files.add(rel);
          byScreen.set(e.screen, g);
        }
      }
      let written = 0;
      for (const g of byScreen.values()) {
        const target = join(outDir, `${screenId(g.screen)}.yaml`);
        const text = renderElementFile(g.screen, g.elements, `Generated by "eztest elements import-screens" from ${[...g.files].join(', ')}. Edit freely: this file now owns these elements.`);
        const rel = relative(io.cwd, target).split('\\').join('/');
        if (existsSync(target) && !o.force) {
          io.err(`exists, not overwritten (use --force): ${rel}`);
          continue;
        }
        if (o.dryRun) io.out(`--- ${rel}\n${text}`);
        else {
          await mkdir(outDir, { recursive: true });
          await writeFile(target, text);
          io.out(`wrote ${rel} (${g.elements.length} element${g.elements.length === 1 ? '' : 's'})`);
        }
        written++;
      }
      io.out(`${written} screen file${written === 1 ? '' : 's'}${problems ? `, ${problems} entr${problems === 1 ? 'y' : 'ies'} skipped (functions or computed values stay in code)` : ''}`);
    });
}
