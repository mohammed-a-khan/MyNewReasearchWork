/**
 * Child process for the cross-process lock test: runs journeys in a real
 * browser with file-based resource locks and writes when each journey
 * started and ended. Usage: lock-worker.ts <lockDir> <outDir> <name> <resultFile>
 */
import { writeFile } from 'node:fs/promises';
import { EventBus } from '../../../src/core/index.js';
import { parseEzScript } from '../../../src/intent/index.js';
import { runJourneys } from '../../../src/runner/index.js';
import { FileLockBackend, JourneyLocker } from '../../../src/scale/index.js';

const [lockDir, outDir, name, resultFile] = process.argv.slice(2);
const locked = parseEzScript(`Journey: ${name} edits account 1\nId: ${name}-account\nLocks: account-<acct>\n\nWait 1200 ms\n\nExamples:\n| acct |\n| 1 |\n`);
const free = parseEzScript(`Journey: ${name} reads the catalogue\nId: ${name}-free\n\nWait 200 ms\n`);
const times: Record<string, { start?: number; end?: number }> = {};
const bus = new EventBus();
bus.on((e) => {
  if (e.type === 'journey:start') times[e.journeyId] = { start: Date.now() };
  if (e.type === 'journey:end') times[e.journeyId].end = Date.now();
});
const locker = new JourneyLocker({ backend: new FileLockBackend({ dir: lockDir, ttlMs: 10_000, owner: name }), pollMs: 50 });
const run = await runJourneys([locked, free], {
  outputDir: outDir, concurrency: 2, screenshots: 'off', events: bus,
  locks: { tryAcquire: (j) => locker.tryAcquire(j), pollMs: 50, timeoutMs: 60_000 },
});
await writeFile(resultFile, JSON.stringify({ times, statuses: run.journeys.map((j) => [j.journeyId, j.status, j.error?.message]) }));
