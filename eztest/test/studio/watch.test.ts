/** File watching: the watcher (native and polling) and live `files`/`problems` events plus the problems index. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JourneyWatcher, startStudio, type FileChange, type StudioHandle } from '../../src/studio/index.js';
import { client, copyShopProject, readSse } from './helpers.js';

async function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('JourneyWatcher', () => {
  for (const poll of [false, true]) {
    it(`reports added, changed and removed journey files (${poll ? 'polling' : 'native'})`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'ez-watch-'));
      const dir = join(root, 'journeys');
      await mkdir(join(dir, 'sub'), { recursive: true });
      await writeFile(join(dir, 'a.ez'), 'Journey: A\nOpen /\n');
      const seen: FileChange[] = [];
      const w = await new JourneyWatcher({ cwd: root, dir, onChange: (c) => seen.push(...c), poll, pollMs: 100, debounceMs: 30 }).start();
      try {
        expect(w.mode).toBe(poll ? 'poll' : 'watch');
        expect(w.files()).toEqual(['journeys/a.ez']);
        await writeFile(join(dir, 'sub', 'b.yaml'), 'name: B\nsteps: ["Open /"]\n');
        await writeFile(join(dir, 'notes.txt'), 'ignored');
        await waitFor(() => seen.find((c) => c.path === 'journeys/sub/b.yaml' && c.type === 'added'));
        await new Promise((r) => setTimeout(r, 20));
        await writeFile(join(dir, 'a.ez'), 'Journey: A\nOpen /\nReload the page\n');
        await waitFor(() => seen.find((c) => c.path === 'journeys/a.ez' && c.type === 'changed'));
        await rm(join(dir, 'sub', 'b.yaml'));
        await waitFor(() => seen.find((c) => c.path === 'journeys/sub/b.yaml' && c.type === 'removed'));
        expect(seen.some((c) => c.path.endsWith('notes.txt'))).toBe(false);
      } finally {
        w.close();
      }
    });
  }

  it('polls until the directory exists, then picks files up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ez-watch-late-'));
    const seen: FileChange[] = [];
    const w = await new JourneyWatcher({ cwd: root, dir: join(root, 'journeys'), onChange: (c) => seen.push(...c), pollMs: 100 }).start();
    try {
      await mkdir(join(root, 'journeys'));
      await writeFile(join(root, 'journeys', 'late.ez'), 'Journey: Late\nOpen /\n');
      await waitFor(() => seen.find((c) => c.path === 'journeys/late.ez'));
    } finally {
      w.close();
    }
  });
});

describe('Studio live file updates', () => {
  let studio: StudioHandle;
  let project: string;
  beforeAll(async () => {
    project = await copyShopProject();
    studio = await startStudio({ cwd: project });
  });
  afterAll(async () => studio?.close());

  it('publishes file changes and problems over /api/events and keeps /api/problems current', async () => {
    const c = client(studio.port, studio.token);
    expect((await c.get('/api/problems')).json().files).toEqual([]);
    const since = studio.app.hub.lastSeq;
    const events = readSse(studio.port, `/api/events?topics=files,problems&since=${since}`, studio.token, (e) => e.topic === 'problems' && e.path === 'journeys/broken.ez', 15_000);
    // Edited "in another editor": written straight to disk.
    await writeFile(join(project, 'journeys', 'broken.ez'), 'Journey: Broken\nOpne /login\n');
    const got = await events;
    expect(got.find((e) => e.topic === 'files')).toMatchObject({ type: 'added', path: 'journeys/broken.ez' });
    const p = got.find((e) => e.topic === 'problems')!;
    expect(p.errors[0]).toMatchObject({ line: 2 });
    expect(p.errors[0].suggestions).toContain('Open /login');
    const problems = (await c.get('/api/problems')).json().files;
    expect(problems).toEqual([expect.objectContaining({ path: 'journeys/broken.ez' })]);
    // Fixing it clears the problem.
    await writeFile(join(project, 'journeys', 'broken.ez'), 'Journey: Fixed\nOpen /login\n');
    const end = Date.now() + 10_000;
    while (Date.now() < end && (await c.get('/api/problems')).json().files.length) await new Promise((r) => setTimeout(r, 100));
    expect((await c.get('/api/problems')).json().files).toEqual([]);
    expect((await c.get('/api/journeys')).json().journeys.map((j: { name: string }) => j.name)).toContain('Fixed');
  });
});
