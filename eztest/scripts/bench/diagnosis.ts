/**
 * Time to understand a failure, on planted defects in the demo app.
 *
 * Each defect is run twice: "before" (no failure diagnosis, no reliability
 * classification) and "after" (defaults). For each failure we check whether
 * the failure message alone states the root cause (a per-defect regex of the
 * facts a person needs), and estimate the time to understand it with a simple,
 * documented model (no user study):
 *
 *   reading time = words in the message / 200 words per minute
 *   + 45 s for every artifact a person must open to find the cause
 *     (screenshot, HTML, network log, console log, a database query by hand)
 *     when the message does not state it.
 *
 *   npx tsx scripts/bench/diagnosis.ts [out.json]
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '../../src/browser/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys, type RunOptions } from '../../src/runner/index.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';

interface Defect {
  id: string;
  ez: string;
  /** The facts that identify the root cause. */
  cause: RegExp;
  /** Artifacts a person opens when the message does not state the cause. */
  artifacts: number;
  options?: (s: DemoServer) => Partial<RunOptions>;
}

const db = (s: DemoServer): Partial<RunOptions> => ({
  db: { query: async (_c, sql, params) => s.db.prepare(sql).all(...((params ?? []) as Array<string | number | null>)) as Array<Record<string, unknown>> },
});

const DEFECTS: Defect[] = [
  { id: 'renamed-button', artifacts: 2, cause: /did you mean role=button "Save"/, ez: 'Journey: Renamed\nOpen /rel/overlay?ms=0\nClick the "Save settings" button\n  Expect the page contains "Saved"\n' },
  { id: 'stuck-overlay', artifacts: 1, cause: /covered by .*cookie-banner/, ez: 'Journey: Overlay\nOpen /rel/overlay?ms=never\nClick the "Save" button\n  Expect the page contains "Saved"\n' },
  { id: 'backend-503', artifacts: 2, cause: /\/rel\/api\/broken -> HTTP 503/, ez: 'Journey: Backend\nOpen /rel/error-page\nClick the "Run report" button\n  Expect the page contains "Report done"\n' },
  { id: 'console-error', artifacts: 1, cause: /ReportService failed/, ez: 'Journey: Console\nOpen /rel/error-page\nClick the "Run report" button\n  Expect the page contains "Report done"\n' },
  { id: 'missing-data', artifacts: 2, cause: /data problem: db demo .*0 row/, ez: `Journey: Data\nRequires: db demo "SELECT id FROM customers WHERE region = 'XX'" has rows\nOpen /rel/customers?region=XX\n  Expect the page contains "Contoso"\n`, options: db },
  { id: 'environment-503', artifacts: 1, cause: /HTTP 503/, ez: 'Journey: Env\nOpen /rel/env/x?fail=503\nClick the "Go" button\n  Expect the page contains "Went"\n' },
  {
    id: 'session-expired', artifacts: 1, cause: /session\/login\?expired|session (?:has )?expired/i, ez: 'Journey: Session\nLog in as bob\nOpen /rel/session/expire-all\nGo to /rel/session/area/reports\n  Expect the page contains "Section /reports"\n',
    options: () => ({
      login: async (page: Page, _r: string, ctx: { baseUrl?: string }) => {
        await page.goto(`${ctx.baseUrl}/rel/session/login`);
        await page.getByLabel('Username').fill('bob');
        await page.getByLabel('Password').fill('Builder#2');
        await Promise.all([page.waitForURL(/area/), page.getByRole('button', { name: 'Sign in' }).click()]);
      },
    }),
  },
];

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function main(): Promise<void> {
  const server = await startDemoApp();
  const out = await mkdtemp(join(tmpdir(), 'eztest-diag-'));
  const rows: Array<Record<string, unknown>> = [];
  try {
    for (const mode of ['before', 'after'] as const) {
      for (const d of DEFECTS) {
        const base: Partial<RunOptions> = mode === 'before'
          ? { diagnose: false, reliability: { actionability: false, appIdle: false, verifyFill: false, reresolve: false } }
          : {};
        // "before" is EZTest without this work: no Requires: preconditions either (the journey just runs and fails).
        const journey = parseEzScript(d.ez);
        if (mode === 'before') delete journey.requires;
        const r = await runJourneys([journey], { baseUrl: server.url, outputDir: join(out, mode), stepTimeoutMs: 2500, locateTimeoutMs: 1200, conditionTimeoutMs: 1200, ...base, ...(d.options?.(server) ?? {}) });
        const j = r.journeys[0];
        const failed = j.steps.find((s) => s.status === 'failed');
        // What a person sees first: the failing step's message (else the journey error), plus the triage-relevant journey notes.
        const message = [failed?.error?.message ?? j.error?.message ?? '', mode === 'after' && j.reliability?.environment ? `environment: ${j.reliability.environment.reason}` : ''].filter(Boolean).join(' | ');
        const stated = d.cause.test(message) || (mode === 'after' && !!failed?.diagnosis && d.cause.test(JSON.stringify(failed.diagnosis)));
        const seconds = Math.round((words(message) / 200) * 60 + (stated ? 0 : d.artifacts * 45));
        rows.push({ mode, defect: d.id, status: j.status, causeInMessage: stated, seconds, message: message.slice(0, 220) });
      }
    }
  } finally {
    await server.close();
  }
  const summary = Object.fromEntries((['before', 'after'] as const).map((m) => {
    const mine = rows.filter((r) => r.mode === m);
    return [m, { medianSeconds: median(mine.map((r) => r.seconds as number)), causeStated: `${mine.filter((r) => r.causeInMessage).length}/${mine.length}` }];
  }));
  for (const r of rows) process.stdout.write(`${r.mode}\t${r.defect}\t${r.causeInMessage ? 'cause stated' : 'needs artifacts'}\t${r.seconds}s\t${r.message}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify({ summary, rows }, null, 2));
}

await main();
