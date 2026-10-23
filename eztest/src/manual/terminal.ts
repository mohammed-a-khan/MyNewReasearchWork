/**
 * Manual verdicts in a terminal (`eztest run --manual prompt`): each manual
 * step is printed with its expected results and the tester answers
 * p(ass) / f(ail) / b(locked) / s(kip) / q(uit), then optional notes.
 * Attachments are file paths (read from disk). Answers are masked like logs.
 */
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { Readable } from 'node:stream';
import { ManualRunEnded, type ManualAttachment, type ManualStepRequest, type ManualVerdict, type ManualVerdictProvider } from '../runner/manual.js';

export interface TerminalManualOptions {
  input: Readable;
  output: (text: string) => void;
  masker?: { mask(text: string): string };
  /** Tester name (default $EZTEST_TESTER, else asked once). */
  tester?: string;
  /** Base directory for attachment paths. */
  cwd?: string;
}

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json', '.log': 'text/plain' };

/** A line reader over a stream that hands out answers in order (works with piped input too). */
function lineReader(input: Readable): { next(): Promise<string | undefined>; close(): void } {
  const rl: Interface = createInterface({ input, terminal: false });
  const queue: string[] = [];
  const waiters: Array<(v: string | undefined) => void> = [];
  let closed = false;
  rl.on('line', (l) => (waiters.length ? waiters.shift()!(l) : queue.push(l)));
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()!(undefined);
  });
  return {
    next: () => (queue.length ? Promise.resolve(queue.shift()) : closed ? Promise.resolve(undefined) : new Promise((r) => waiters.push(r))),
    close: () => rl.close(),
  };
}

export function terminalManualProvider(o: TerminalManualOptions): ManualVerdictProvider & { close(): void } {
  const lines = lineReader(o.input);
  const out = (t: string) => o.output(o.masker ? o.masker.mask(t) : t);
  let tester = o.tester ?? process.env.EZTEST_TESTER;
  const ask = async (q: string): Promise<string> => {
    out(q);
    const a = await lines.next();
    if (a === undefined) throw new ManualRunEnded('input closed: the remaining manual steps are not executed');
    return a.trim();
  };
  return {
    close: () => lines.close(),
    async verdict(req: ManualStepRequest): Promise<ManualVerdict> {
      if (!tester) tester = (await ask('Tester name: ')) || undefined;
      out(`\n  Manual step ${req.index}/${req.total} of "${req.journeyName}"${req.hybrid && req.url ? ` (page: ${req.url})` : ''}`);
      if (req.preconditions && req.index === 1) out(`  Preconditions: ${req.preconditions}`);
      out(`  > ${req.instruction}`);
      for (const e of req.expected) out(`    Expected: ${e}`);
      for (const a of req.attachments) out(`    Reference: ${a}`);
      for (;;) {
        const a = (await ask('  Verdict [p]ass, [f]ail, [b]locked, [s]kip, [q]uit: ')).toLowerCase();
        const status = a.startsWith('p') ? 'passed' : a.startsWith('f') ? 'failed' : a.startsWith('b') ? 'blocked' : a.startsWith('s') ? 'skipped' : a.startsWith('q') ? 'quit' : undefined;
        if (!status) continue;
        if (status === 'quit') throw new ManualRunEnded();
        const notes = status === 'passed' ? '' : await ask('  Notes (what you saw): ');
        const files = await ask('  Attach files (paths, comma separated, empty for none): ');
        const attachments: ManualAttachment[] = [];
        for (const f of files.split(',').map((x) => x.trim()).filter(Boolean)) {
          try {
            const p = resolve(o.cwd ?? process.cwd(), f);
            attachments.push({ name: basename(p), contentType: TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream', data: await readFile(p) });
          } catch (e) {
            out(`  (not attached: ${(e as Error).message})`);
          }
        }
        return { status, ...(notes ? { notes } : {}), ...(tester ? { tester } : {}), attachments };
      }
    },
  };
}
