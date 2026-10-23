/**
 * `eztest stories`: run .ez journeys against single component stories through
 * EZTest's own harness, and `eztest stories list` to show the stories a set
 * of CSF files defines. The harness mounts each story in an isolated page
 * (see src/stories/harness.ts); journeys reach a story with a `Story:` header.
 */
import { Command } from 'commander';
import { resolve } from 'node:path';
import { createEngine, lensesFromConfig } from '../engine/index.js';
import { loadJourneys } from './journeys.js';
import { StoryHarness, listStoryFiles } from '../stories/index.js';
import type { LoadedConfig } from '../config/index.js';
import type { CliIO } from './program.js';
import { expandGlobs } from '../insights/glob.js';

type Loader = (o: { config?: string; env?: string; project?: string }) => Promise<LoadedConfig>;
const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
const DEFAULT_GLOBS = ['**/*.stories.ts', '**/*.stories.tsx', '**/*.stories.js', '**/*.stories.jsx'];

export function registerStoriesCommands(program: Command, io: CliIO, load: Loader): void {
  const cmd = program.command('stories').description('EZTest component/story harness: run journeys against single stories, or list stories');

  cmd
    .command('list')
    .description('list the stories defined by CSF files')
    .option('-s, --stories <globs>', 'story file globs', list)
    .option('--json', 'print JSON')
    .action(async (o: { stories?: string[]; json?: boolean }) => {
      const files = await expandGlobs(o.stories ?? DEFAULT_GLOBS, io.cwd);
      if (!files.length) throw new Error(`no story files matched ${(o.stories ?? DEFAULT_GLOBS).join(', ')}`);
      const stories = await listStoryFiles(files, io.cwd);
      if (o.json) io.out(JSON.stringify(stories, null, 2));
      else for (const s of stories) io.out(`${s.id}\t${s.title} / ${s.name}${s.argNames.length ? ` (args: ${s.argNames.join(', ')})` : ''}`);
    });

  cmd
    .command('run', { isDefault: true })
    .description('run journeys (with Story: headers) against the harness')
    .argument('[paths...]', 'journey files or directories')
    .option('-c, --config <file>', 'config file')
    .option('-e, --env <name>', 'environment name')
    .option('--project <name>', 'project overlay')
    .option('-s, --stories <globs>', 'story file globs', list)
    .option('--renderer <module>', 'a renderer module exporting mount(root, component, args) (default: the built-in DOM renderer)')
    .option('--head <files>', 'CSS files or HTML injected into every story page head', list)
    .option('-b, --browser <name>', 'chromium (default), firefox or webkit')
    .option('--lens <names>', 'lenses after every step (default: a11y, visual)', list)
    .action(async (paths: string[], o: { config?: string; env?: string; project?: string; stories?: string[]; renderer?: string; head?: string[]; browser?: string; lens?: string[] }) => {
      const loaded = await load(o);
      const cfg = loaded.config;
      const files = await expandGlobs(o.stories ?? DEFAULT_GLOBS, io.cwd);
      if (!files.length) throw new Error(`no story files matched ${(o.stories ?? DEFAULT_GLOBS).join(', ')}`);
      const harness = new StoryHarness({ files, cwd: io.cwd, ...(o.renderer ? { renderer: o.renderer } : {}), ...(o.head ? { head: o.head } : {}) });
      await harness.start();
      io.out(`harness: ${harness.list().length} stories at ${harness.url}`);
      const { journeys, errors } = await loadJourneys(paths.length ? paths : [cfg.journeysDir], io.cwd);
      for (const e of errors) io.err(`parse error: ${e.message}`);
      const withStory = journeys.filter((j) => j.story);
      if (!withStory.length) throw new Error('no journeys with a "Story:" header were found');
      const lensNames = o.lens ?? ['a11y', 'visual'];
      const engine = await createEngine(loaded, {
        cwd: io.cwd,
        runOptions: {
          ...(o.browser ? { browser: o.browser as 'chromium' | 'firefox' | 'webkit' } : {}),
          screenshots: 'on-failure',
          lenses: lensesFromConfig(lensNames, io.cwd, { branchBaselines: cfg.vcs.branchScope.baselines, defaultBranch: cfg.vcs.branchScope.defaultBranch }),
          storyHarness: harness,
        },
      });
      try {
        const run = await engine.run(withStory);
        const s = run.summary;
        io.out(`${s.total} stories checked: ${s.passed} passed, ${s.passedHealed} healed, ${s.failed} failed, ${s.errors} errors`);
        process.exitCode = s.failed + s.errors > 0 ? 1 : 0;
      } finally {
        await engine.close();
        await harness.stop();
      }
    });
}
