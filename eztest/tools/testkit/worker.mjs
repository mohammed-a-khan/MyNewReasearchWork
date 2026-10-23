/**
 * One test file per worker process (forked by cli.mjs with `--import register.mjs`),
 * so every file gets a fresh module graph. Reports over the IPC channel:
 *   { type: 'test-start' | 'test-end' | 'hook-start' | 'hook-end' | 'done' | 'handles', ... }
 * After the file it lets the process drain; whatever still keeps it alive after
 * the grace period is reported as open handles and the process exits.
 */
const GRACE_MS = Number(process.env.TESTKIT_GRACE_MS ?? 1000);

const send = (msg) =>
  new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send(msg, (err) => resolve(err));
  });

function counts(list) {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

const baseline = counts(process.getActiveResourcesInfo());

/** Resources beyond the worker's own (its drain timer counts as one Timeout). */
function leftovers() {
  const now = counts(process.getActiveResourcesInfo());
  now.set('Timeout', (now.get('Timeout') ?? 0) - 1);
  const out = [];
  for (const [k, n] of now) {
    const extra = n - (baseline.get(k) ?? 0);
    if (extra > 0 && k !== 'TTYWrap') out.push(extra > 1 ? `${k} x${extra}` : k);
  }
  return out;
}

const job = JSON.parse(process.env.TESTKIT_JOB);
// Processes the tests start need not see the job.
delete process.env.TESTKIT_JOB;
delete process.env.TESTKIT_LOADER_OPTIONS;
// The runner went away (killed or interrupted): do not linger as an orphan.
process.on('disconnect', () => process.exit(1));
const { runFile, unhandled } = await import('./runtime.ts');

process.on('unhandledRejection', (e) => unhandled(e, 'Unhandled Rejection'));
process.on('uncaughtException', (e) => unhandled(e, 'Uncaught Exception'));

const events = {
  testStart: (path, timeoutMs) => void send({ type: 'test-start', path, timeoutMs }),
  testEnd: (result) => void send({ type: 'test-end', result }),
  hookStart: (kind, timeoutMs) => void send({ type: 'hook-start', kind, timeoutMs }),
  hookEnd: () => void send({ type: 'hook-end' }),
};

let result;
try {
  result = await runFile(job.file, job.options, events);
} catch (e) {
  result = { file: job.file, tests: [], errors: [{ name: e?.name ?? 'Error', message: String(e?.stack ?? e), where: 'testkit worker' }], durationMs: 0 };
}
// Let late rejections surface before reporting.
await new Promise((r) => setTimeout(r, 20));
await send({ type: 'done', result });

const deadline = Date.now() + GRACE_MS;
const timer = setInterval(async () => {
  const left = leftovers();
  if (left.length && Date.now() < deadline) return;
  clearInterval(timer);
  if (left.length) await send({ type: 'handles', handles: left });
  process.exit(0);
}, 50);
timer.unref();
process.channel?.unref();
