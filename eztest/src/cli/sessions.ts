/**
 * `eztest sessions`: turn captured user sessions (EZTest capture files, HAR,
 * rrweb event JSON) into candidate `.ez` journeys ranked by frequency, with a
 * coverage gap against the project's existing journeys. `eztest sessions
 * snippet` prints the privacy-safe capture snippet to embed.
 */
import { Command } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Journey } from '../core/index.js';
import { loadJourneys } from './journeys.js';
import { expandGlobs } from '../insights/index.js';
import { captureSnippet, clusterSessions, coverageGap, generateJourneys, parseSession, type CapturedSession } from '../sessions/index.js';
import type { CliIO } from './program.js';

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
const countBy = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

export function registerSessionsCommands(program: Command, io: CliIO): void {
  const cmd = program.command('sessions').description('turn captured user sessions (EZTest capture, HAR, rrweb JSON) into candidate journeys');

  cmd
    .command('snippet')
    .description('print the opt-in, privacy-safe capture snippet to embed in a test/staging environment')
    .option('--allow <fields>', 'field names/ids/testids/labels whose masked value may be recorded', list)
    .option('--endpoint <url>', 'POST captured sessions here (navigator.sendBeacon)')
    .option('--autostart', 'start recording on load (otherwise call window.__ezCapture.start())')
    .action((o: { allow?: string[]; endpoint?: string; autostart?: boolean }) => {
      io.out(captureSnippet({ ...(o.allow ? { allowValues: o.allow } : {}), ...(o.endpoint ? { endpoint: o.endpoint } : {}), ...(o.autostart ? { autostart: true } : {}) }));
    });

  cmd
    .command('import', { isDefault: true })
    .description('read session files, cluster them into common paths and write ranked .ez journeys')
    .argument('<paths...>', 'session files or directories (*.json, *.har)')
    .option('-o, --out <dir>', 'output directory', 'journeys/captured')
    .option('--min-count <n>', 'only paths seen at least n times', (v) => parseInt(v, 10), 1)
    .option('--against <dir>', 'existing journeys to compute the coverage gap against')
    .option('--prefix <name>', 'name prefix for generated journeys', 'Captured journey')
    .option('--json', 'print the report as JSON')
    .action(async (paths: string[], o: { out: string; minCount: number; against?: string; prefix: string; json?: boolean }) => {
      const files = await expandGlobs(paths.flatMap((p) => (/[*?{]/.test(p) ? [p] : [p])), io.cwd);
      const candidates = files.filter((f) => /\.(json|har)$/i.test(f));
      if (!candidates.length) throw new Error(`no .json or .har session files under ${paths.join(', ')}`);
      const sessions: CapturedSession[] = [];
      const skipped: string[] = [];
      for (const f of candidates) {
        try {
          const doc = JSON.parse(await readFile(f, 'utf8')) as unknown;
          const s = parseSession(doc, f, `sess-${sessions.length + 1}`);
          if (s && s.events.length) sessions.push(s);
          else skipped.push(`${f}: not a recognised session format (EZTest capture, HAR or rrweb)`);
        } catch (e) {
          skipped.push(`${f}: ${(e as Error).message}`);
        }
      }
      for (const s of skipped) io.err(`skipped ${s}`);
      if (!sessions.length) throw new Error('no usable sessions were read');

      const clusters = clusterSessions(sessions);
      const generated = generateJourneys(clusters, { minCount: o.minCount, namePrefix: o.prefix });
      const outDir = resolve(io.cwd, o.out);
      await mkdir(outDir, { recursive: true });
      for (const g of generated) await writeFile(join(outDir, `${g.id}.ez`), g.ez);

      let gap;
      if (o.against) {
        const existing: Journey[] = (await loadJourneys([o.against], io.cwd)).journeys;
        gap = coverageGap(clusters, existing);
      }

      const report = {
        sessions: sessions.length,
        bySource: countBy(sessions.map((s) => s.source)),
        clusters: clusters.length,
        generated: generated.map((g) => ({ id: g.id, name: g.name, count: g.count, frequency: Number(g.frequency.toFixed(3)), placeholders: g.placeholders, signature: g.signature })),
        ...(gap ? { coverage: { ratio: Number(gap.coverageRatio.toFixed(3)), uncovered: gap.uncovered, covered: gap.covered } } : {}),
        skipped,
      };
      await writeFile(join(outDir, 'sessions-report.json'), JSON.stringify(report, null, 2));

      if (o.json) io.out(JSON.stringify(report, null, 2));
      else {
        io.out(`${sessions.length} sessions -> ${clusters.length} path(s); wrote ${generated.length} journeys to ${o.out}`);
        for (const g of generated) io.out(`  ${g.id}  x${g.count} (${(g.frequency * 100).toFixed(0)}%)${g.placeholders.length ? `  [${g.placeholders.length} value(s) to fill]` : ''}`);
        if (gap) {
          io.out(`coverage vs ${o.against}: ${(gap.coverageRatio * 100).toFixed(0)}% of captured sessions already covered; ${gap.uncovered.length} path(s) uncovered`);
          for (const u of gap.uncovered.slice(0, 10)) io.out(`  GAP x${u.count}: ${u.suggestion}`);
        }
      }
      process.exitCode = 0;
    });
}
