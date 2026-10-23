/** Run the configured publishers for a run (after `eztest run`, or `eztest publish`). */
import { silentLogger, type Logger, type RunResult } from '../core/index.js';
import { registries, type PublishResult, type RunAnalysis } from './registry.js';

export interface PublisherSpec {
  use: string;
  when?: 'always' | 'failed' | 'passed';
  [k: string]: unknown;
}

export async function runPublishers(
  specs: PublisherSpec[],
  ctx: { run: RunResult; runDir: string; analysis?: RunAnalysis; resolveSecret: (v: string) => Promise<string>; runUrl?: string; fetch?: typeof fetch; logger?: Logger; only?: string[]; dryRun?: boolean },
): Promise<Array<PublishResult & { publisher: string; skipped?: boolean }>> {
  const out: Array<PublishResult & { publisher: string; skipped?: boolean }> = [];
  const failed = ctx.run.summary.failed + ctx.run.summary.errors > 0;
  for (const spec of specs) {
    if (ctx.only?.length && !ctx.only.includes(spec.use)) continue;
    const when = spec.when ?? 'always';
    if ((when === 'failed' && !failed) || (when === 'passed' && failed)) {
      out.push({ publisher: spec.use, ok: true, skipped: true, message: `skipped (when: ${when})` });
      continue;
    }
    const p = registries.publishers.get(spec.use);
    if (!p) {
      out.push({ publisher: spec.use, ok: false, message: `no publisher "${spec.use}" (known: ${registries.publishers.names().join(', ') || 'none'}; plugins add more)` });
      continue;
    }
    const { use: _u, when: _w, ...rest } = spec;
    const options = ctx.dryRun ? { ...rest, dryRun: true } : rest;
    try {
      const r = await p.publish({
        run: ctx.run, runDir: ctx.runDir, analysis: ctx.analysis ?? {}, options, resolveSecret: async (v) => (v.startsWith('secret://') ? ctx.resolveSecret(v) : v),
        runUrl: ctx.runUrl, fetch: ctx.fetch ?? fetch, logger: ctx.logger ?? silentLogger,
      });
      out.push({ publisher: spec.use, ...r });
    } catch (e) {
      out.push({ publisher: spec.use, ok: false, message: (e as Error).message });
    }
  }
  return out;
}
