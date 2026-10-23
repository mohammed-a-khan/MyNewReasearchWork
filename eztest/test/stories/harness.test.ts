/**
 * Component / story harness end to end (gap G32): EZTest's own harness mounts
 * a component from the project's bundler output (esbuild) in an isolated page,
 * reading a Storybook CSF story file as input, and .ez journeys with a `Story:`
 * header check single stories in a real browser with the visual and a11y
 * lenses. No Storybook test-runner, no Playwright component testing.
 */
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { flattenStepResults, type JourneyResult } from '../../src/core/index.js';
import { lensesFromConfig } from '../../src/engine/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys, type RunOptions } from '../../src/runner/index.js';
import { StoryHarness, listStoryFiles, readStoryFile } from '../../src/stories/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STORY = join(HERE, 'fixtures', 'button.stories.ts');

let harness: StoryHarness;
beforeAll(async () => {
  harness = await new StoryHarness({ files: [STORY], cwd: HERE });
  await harness.start();
}, 60_000);
afterAll(async () => {
  await harness?.stop();
});

const describeSteps = (j: JourneyResult) => flattenStepResults(j.steps).map(({ result: s }) => `${s.intent}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');

async function run(ez: string, opts: Partial<RunOptions> = {}) {
  const outputDir = opts.outputDir ?? (await mkdtemp(join(tmpdir(), 'eztest-story-')));
  const r = await runJourneys([parseEzScript(ez)], { outputDir, stepTimeoutMs: 15_000, conditionTimeoutMs: 4000, storyHarness: harness, viewport: { width: 400, height: 200 }, ...opts });
  return { run: r, j: r.journeys[0], outputDir };
}

describe('story harness', () => {
  it('discovers stories from a CSF file (title slug + story names + args)', () => {
    const meta = readStoryFile('export default { title: "Example/Button", args: { label: "x" } };\nexport const Primary = { args: { variant: "primary" } };\nexport function Loading() {}', 'x.stories.ts');
    expect(meta.titleRaw).toBe('Example/Button');
    expect(meta.stories.map((s) => s.name)).toEqual(['Primary', 'Loading']);
    expect(harness.list().map((s) => s.id).sort()).toEqual(['example-button--danger', 'example-button--inaccessible', 'example-button--primary', 'example-button--secondary']);
    expect(harness.list().find((s) => s.id === 'example-button--primary')?.argNames).toContain('label');
  });

  it('mounts three button variants and checks each with the a11y and visual lenses', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'eztest-story-'));
    const lenses = lensesFromConfig(['a11y', 'visual'], outputDir, { updateBaselines: true });
    for (const [story, label, variant] of [['example-button--primary', 'Click me', 'primary'], ['example-button--secondary', 'Cancel', 'secondary'], ['example-button--danger', 'Delete', 'danger']] as const) {
      const { j } = await run(`Journey: ${story}
Story: ${story}
Expect the page to contain "${label}"
Expect the "${label}" button to be visible
`, { outputDir, lenses });
      expect(j.status, describeSteps(j)).toMatch(/^passed/);
      // the right variant mounted
      const { j: check } = await run(`Journey: variant ${story}
Story: ${story}
Expect the "data-variant" attribute of the "${label}" button is "${variant}"
`, { outputDir });
      expect(check.status, describeSteps(check)).toMatch(/^passed/);
    }
  }, 120_000);

  it('passes Examples args to the story as URL parameters', async () => {
    const { run: r } = await run(`Journey: labelled
Story: example-button--primary
Variables: label=Submit, variant=secondary
Expect the "Submit" button to be visible
Expect the "data-variant" attribute of the "Submit" button is "secondary"
`);
    expect(r.journeys[0].status, describeSteps(r.journeys[0])).toMatch(/^passed/);
  });

  it('runs one journey per Examples row (args from the row)', async () => {
    const r = await runJourneys(
      [parseEzScript(`Journey: variants
Story: example-button--primary
Expect the "<label>" button to be visible
Expect the "data-variant" attribute of the "<label>" button is "<variant>"
Examples:
| label | variant |
| One | primary |
| Two | secondary |
`)],
      { outputDir: await mkdtemp(join(tmpdir(), 'eztest-story-')), stepTimeoutMs: 15_000, conditionTimeoutMs: 4000, storyHarness: harness },
    );
    expect(r.journeys).toHaveLength(2);
    expect(r.journeys.every((j) => j.status.startsWith('passed')), r.journeys.map(describeSteps).join('\n---\n')).toBe(true);
  }, 60_000);

  it('the a11y lens catches a story with no accessible name', async () => {
    const { j } = await run(`Journey: inaccessible
Story: example-button--inaccessible
Expect the URL to contain "story"
`, { lenses: lensesFromConfig(['a11y'], HERE) });
    expect(j.status).toBe('failed');
    expect(describeSteps(j)).toMatch(/a11y|accessib|button-name/i);
  });

  it('fails clearly for an unknown story', async () => {
    const { j } = await run(`Journey: missing
Story: example-button--nope
Expect the page to be visible
`);
    expect(j.status).toBe('error');
    expect(j.error?.message).toMatch(/no story "example-button--nope"/);
  });

  it('lists stories without a server (CLI / gallery)', async () => {
    const stories = await listStoryFiles([STORY], HERE);
    expect(stories.map((s) => s.name).sort()).toEqual(['Danger', 'Inaccessible', 'Primary', 'Secondary']);
  });

  it('records story evidence under the run', async () => {
    const { run: r, outputDir } = await run(`Journey: ev
Story: example-button--primary
Expect the "Click me" button to be visible
`, { screenshots: 'every-step' });
    const files = await readdir(join(outputDir, r.runId), { recursive: true });
    expect(files.some((f) => typeof f === 'string' && f.endsWith('.png'))).toBe(true);
  });
});
