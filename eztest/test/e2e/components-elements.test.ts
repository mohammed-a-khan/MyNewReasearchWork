/**
 * Element references in the component phrasings (real Chromium, examples/enterprise-app): `Pick ... in the
 * @Widgets.due date picker` finds the widget through the element repository, as `Select "x" from the
 * @Pim.nationality dropdown` does; it was read as the text "@Widgets.due date" and matched nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElementRepository } from '../../src/elements/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { componentEvidence, expectPasses, runEz, startApp } from './components-helpers.js';
import type { EnterpriseApp } from '../../examples/enterprise-app/server.js';

/** Temporary folders this file made, removed at the end. */
const made: string[] = [];
async function tempDirOf(prefix: string): Promise<string> {
  const d = await mkdtemp(prefix);
  made.push(d);
  return d;
}
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

let app: EnterpriseApp;
let elements: ElementRepository;

beforeAll(async () => {
  app = await startApp();
  const dir = await tempDirOf(join(tmpdir(), 'eztest-comp-elements-'));
  await mkdir(join(dir, 'elements'));
  await writeFile(join(dir, 'elements', 'widgets.yaml'), [
    'screen: Widgets',
    'elements:',
    '  due: the "Due date" field',
    '  city: the "City" combobox',
    '  settings:',
    '    description: the settings tabs',
    '    locators:',
    `      - 'css=[aria-label="Settings"]'`,
    '',
  ].join('\n'));
  elements = await ElementRepository.load(dir);
  expect(elements.problems).toEqual([]);
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('component phrasings with @Element references', () => {
  it('the date picker, the combobox and the tabs are found through the repository', async () => {
    const r = await expectPasses(app.url, `
Journey: Widgets by element reference
Open /lib/aria?locale=en-US
Pick 15 March 2027 in the @Widgets.due date picker [id=date]
Expect the @Widgets.due date picker to show 2027-03-15
Choose "Berlin" in the @Widgets.city combobox [id=city]
Expect the @Widgets.city combobox to show "Berlin"
Open the "Billing" tab in the @Widgets.settings tabs [id=tabs]
`, { elements });
    expect((await componentEvidence(r, 'date')).adapter).toBe('aria-datepicker');
    expect((await componentEvidence(r, 'city')).adapter).toBe('aria-combobox');
    expect((await componentEvidence(r, 'tabs')).adapter).toBe('aria-tabs');
  }, 180_000);

  it('the parsed step names the element; an unknown reference fails as unknown, not as page text', async () => {
    const j = parseEzScript('Journey: x\nPick 1990-04-15 in the @Pim.dateOfBirth date picker\nSet the @Pim.dateOfBirth date picker to 2020-01-01\n');
    expect(j.steps.map((s) => s.target?.element)).toEqual(['Pim.dateOfBirth', 'Pim.dateOfBirth']);
    expect(j.steps[0].target?.locators).toEqual([]);
    const r = await runEz(app.url, 'Journey: Unknown\nOpen /lib/aria\nPick 15 March 2027 in the @Widgets.nope date picker\n', { elements });
    expect(r.j.status).toBe('failed');
    expect(JSON.stringify(r.j)).toMatch(/Widgets\.nope/);
    expect(JSON.stringify(r.j)).not.toMatch(/"@Widgets\.nope date"/);
  }, 120_000);
});
