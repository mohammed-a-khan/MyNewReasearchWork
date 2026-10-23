/**
 * The named-query catalogue end to end on SQLite (always runs, no server
 * needed): config db.queries, catalogue steps in a journey, `eztest validate`,
 * `queries list|check`, `doctor`, and Examples rows from a query.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../../src/cli/index.js';
import { loadConfig } from '../../src/config/index.js';
import type { RunResult } from '../../src/core/index.js';
import { createEngine } from '../../src/engine/index.js';
import { SqliteDbClient, loadDriver } from '../../src/surfaces/index.js';
import { startStudio } from '../../src/studio/index.js';
import { chromium } from '../../src/browser/index.js';
import { client } from '../studio/helpers.js';

async function cli(cwd: string, args: string[]): Promise<{ out: string[]; err: string[]; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: process.env }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out, err, exitCode };
}

describe('named-query catalogue on SQLite (end to end)', () => {
  let project: string;

  beforeAll(async () => {
    project = await mkdtemp(join(tmpdir(), 'eztest-q-sqlite-'));
    const db = new SqliteDbClient({ file: join(project, 'garden.db') });
    await db.execute('CREATE TABLE plants (id INTEGER PRIMARY KEY, name TEXT NOT NULL, zone TEXT NOT NULL, height_cm REAL, retired INTEGER DEFAULT 0)');
    for (const [id, name, zone, h] of [[1, 'Lavender', 'sun', 60], [2, 'Hosta', 'shade', 45], [3, 'Fern', 'shade', 70], [4, 'Thyme', 'sun', 20]] as const) {
      await db.execute('INSERT INTO plants (id, name, zone, height_cm) VALUES (?, ?, ?, ?)', [id, name, zone, h]);
    }
    await db.close();
    await mkdir(join(project, 'queries', 'fragments'), { recursive: true });
    await mkdir(join(project, 'journeys'), { recursive: true });
    await writeFile(join(project, 'eztest.config.yaml'), `outputDir: results
reporters: [json]
healing: { enabled: false }
db:
  connections:
    garden: { type: sqlite, file: ${join(project, 'garden.db')} }
  queries:
    dir: queries
    inline:
      PLANT_COUNT: SELECT COUNT(*) AS n FROM plants
`);
    await writeFile(join(project, 'queries', 'fragments', 'not_retired.sql'), '-- fragment: true\nAND p.retired = 0');
    await writeFile(join(project, 'queries', 'PLANTS_IN_ZONE.sql'), '-- connection: garden\n-- description: Plants for a light zone\n-- params: zone, min_height:number = 0\nSELECT p.id, p.name, p.height_cm FROM plants p\n WHERE p.zone = :zone AND p.height_cm >= :min_height\n {{> not_retired}}\n ORDER BY p.id');
    await writeFile(join(project, 'queries', 'PLANT_NAME.sql'), '-- connection: garden\nSELECT name FROM plants WHERE id = :id');
    await writeFile(join(project, 'journeys', 'garden.ez'), `Journey: Garden catalogue queries
Set variable zone to "shade"
Run query "PLANTS_IN_ZONE" with zone=\${zone} and store the rows as shady
Expect len(shady) == 2
Expect query "PLANTS_IN_ZONE" with zone="sun", min_height=50 returns 1 row
Expect query "PLANTS_IN_ZONE" with zone="x' OR '1'='1" returns no rows
Get the value of query "PLANT_NAME" with id=\${shady.1.ID} as tallest
Expect \${tallest} equals "Fern"
Wait until query "PLANT_COUNT" on garden returns 1 row within 2 seconds
Run query "SELECT id, name, height_cm FROM plants WHERE zone = 'shade' ORDER BY id" on garden as direct
Compare \${direct} with \${shady} by id
`);
  });

  afterAll(async () => {
    // tmp dir left for inspection on failure
  });

  it('validates, lists, checks and runs catalogue queries', async () => {
    const v = await cli(project, ['validate', 'journeys']);
    expect(v.err).toEqual([]);
    expect(v.exitCode).toBe(0);
    const list = await cli(project, ['queries', 'list', '--fragments']);
    expect(list.out.join('\n')).toMatch(/PLANTS_IN_ZONE\s+garden\s+\(zone, min_height=0\) Plants for a light zone/);
    expect(list.out.join('\n')).toMatch(/not_retired\s+-\s+\(fragment\)/);
    const check = await cli(project, ['queries', 'check']);
    expect(check.err).toEqual([]);
    expect(check.out.at(-1)).toBe('3 checked: 3 ok, 0 error(s), 0 skipped');
    const doctor = await cli(project, ['doctor']);
    expect(doctor.out.join('\n')).toMatch(/db garden\s+sqlite ok/);
    const r = await cli(project, ['run', 'journeys']);
    const dirs = (await readdir(join(project, 'results'))).sort();
    const run = JSON.parse(await readFile(join(project, 'results', dirs.at(-1)!, 'run.json'), 'utf8')) as RunResult;
    expect(run.journeys[0].steps.filter((s) => s.status !== 'passed').map((s) => `${s.intent}: ${s.error?.message}`)).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it('fails validation and the run on a missing param or unknown query', async () => {
    await writeFile(join(project, 'journeys', 'bad.ez'), 'Journey: Bad refs\nRun query "PLANTS_IN_ZONE" with min_height=1 as x\n');
    const v = await cli(project, ['validate', 'journeys']);
    expect(v.exitCode).toBe(1);
    expect(v.err.join('\n')).toContain('query "PLANTS_IN_ZONE" needs param "zone"');
    await writeFile(join(project, 'journeys', 'bad.ez'), 'Journey: Bad refs\nRun query "PLANTS_NOWHERE" on garden as x\n');
    const v2 = await cli(project, ['validate', 'journeys/bad.ez']);
    expect(v2.err.join('\n')).toMatch(/Unknown query "PLANTS_NOWHERE"/);
    await writeFile(join(project, 'queries', 'BROKEN.sql'), '-- connection: garden\nSELECT nme FROM plants');
    const check = await cli(project, ['queries', 'check']);
    expect(check.exitCode).toBe(1);
    expect(check.err.join('\n')).toMatch(/ERROR {2}BROKEN on garden: .*no such column: nme/);
    await (await import('node:fs/promises')).rm(join(project, 'queries', 'BROKEN.sql'));
    await (await import('node:fs/promises')).rm(join(project, 'journeys', 'bad.ez'));
  });

  it('resolves Examples rows from a query through the engine', async () => {
    const loaded = await loadConfig({ cwd: project });
    const engine = await createEngine(loaded, { cwd: project });
    try {
      expect(await engine.queryExamples('PLANTS_IN_ZONE', undefined, { zone: 'sun' })).toEqual([
        { id: '1', name: 'Lavender', height_cm: '60' },
        { id: '4', name: 'Thyme', height_cm: '20' },
      ]);
    } finally {
      await engine.close();
    }
  });

  it('Studio workbench: the Queries panel lists, runs (read-only) and saves catalogue queries', async () => {
    await writeFile(join(project, 'journeys', 'saved.ez'), 'Journey: Saved from the workbench\n');
    const studio = await startStudio({ cwd: project, watch: false, env: { ...process.env, EZTEST_MASTER_KEY: undefined } });
    const browser = await chromium.launch();
    try {
      const c = client(studio.port, studio.token);
      const list = (await c.get('/api/workbench/queries')).json();
      expect(list.queries.map((q: { name: string; fragment: boolean }) => `${q.name}${q.fragment ? '*' : ''}`)).toEqual(['not_retired*', 'PLANT_COUNT', 'PLANT_NAME', 'PLANTS_IN_ZONE']);
      const ran = (await c.post('/api/workbench/queries/run', { name: 'PLANTS_IN_ZONE', binds: { zone: "shade' OR '1'='1" } })).json();
      expect(ran).toMatchObject({ kind: 'read', enforced: 'read-only SQLite connection', rowCount: 0 });

      const page = await browser.newPage();
      await page.goto(studio.url);
      await page.goto(`${studio.origin}/#/workbench`);
      // The workbench renders after the hash route settles; a click that lands on the tab bar before then is lost.
      const sqlTab = page.getByRole('tab', { name: 'SQL' });
      await expect.poll(async () => {
        await sqlTab.click();
        return sqlTab.getAttribute('aria-selected');
      }, { timeout: 15_000 }).toBe('true');
      await page.locator('#wb-queries summary').click();
      await page.locator('button[data-query="PLANTS_IN_ZONE"]').click();
      await page.locator('input[data-param="zone"]').fill('shade');
      await page.locator('#wb-query-run').click();
      await expect.poll(() => page.locator('#wb-sql-count').textContent(), { timeout: 20_000 }).toMatch(/2 row\(s\).*read-only SQLite connection/);
      expect(await page.locator('#wb-sql-result table').textContent()).toMatch(/Hosta.*Fern/s);
      await page.locator('#wb-query-save-step').click();
      await expect.poll(() => page.locator('#wb-step-preview').textContent()).toBe('Run query "PLANTS_IN_ZONE" on garden with zone="shade" and store the rows as rows\nExpect the query rows returns 2 rows');
    } finally {
      await browser.close();
      await studio.close();
    }
  });

  it('names the package to install when a driver is missing', async () => {
    const e = await loadDriver('eztest-no-such-driver-pkg', 'Example').catch((x) => x);
    expect(e).toMatchObject({ code: 'DB_DRIVER_MISSING' });
    expect(e.message).toMatch(/npm install eztest-no-such-driver-pkg/);
  });
});
