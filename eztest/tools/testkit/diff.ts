/**
 * Line diff (Myers' O(ND) algorithm) for assertion failures: "- Expected / + Received"
 * with unchanged context lines around each change.
 */
import { isAsymmetric } from './asymmetric.js';
import { equals } from './equals.js';
import { pretty } from './format.js';

export interface Colors {
  red(s: string): string;
  green(s: string): string;
  dim(s: string): string;
}

export const plain: Colors = { red: (s) => s, green: (s) => s, dim: (s) => s };

type Op = { kind: ' ' | '-' | '+'; line: string };

/** Shortest edit script from `a` to `b`, as a list of kept/removed/added lines. */
export function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  const off = max + 1;
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    if ((d + 1) * v.length > 30_000_000) return [...a.map((line) => ({ kind: '-' as const, line })), ...b.map((line) => ({ kind: '+' as const, line }))];
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Backtrack.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: ' ', line: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: '+', line: b[y - 1] });
      else ops.push({ kind: '-', line: a[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** Unified rendering with `context` unchanged lines around changes. */
export function renderDiff(expected: string, received: string, colors: Colors = plain, context = 5): string {
  const ops = diffLines(expected.split('\n'), received.split('\n'));
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.kind === ' ') return;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true;
  });
  const out: string[] = [colors.green('- Expected'), colors.red('+ Received'), ''];
  let skipped = false;
  ops.forEach((op, i) => {
    if (!keep[i]) {
      if (!skipped) out.push(colors.dim('  ...'));
      skipped = true;
      return;
    }
    skipped = false;
    if (op.kind === '-') out.push(colors.green(`- ${op.line}`));
    else if (op.kind === '+') out.push(colors.red(`+ ${op.line}`));
    else out.push(colors.dim(`  ${op.line}`));
  });
  return out.join('\n');
}

/** Replaces asymmetric matchers in `expected` that `actual` satisfies with the actual value, so they print as unchanged. */
function resolveAsymmetric(expected: unknown, actual: unknown, seen = new WeakSet<object>()): unknown {
  if (isAsymmetric(expected)) return expected.matches(actual) ? actual : expected;
  if (!expected || typeof expected !== 'object' || !actual || typeof actual !== 'object') return expected;
  if (seen.has(expected)) return expected;
  seen.add(expected);
  if (Array.isArray(expected)) return Array.isArray(actual) ? expected.map((e, i) => resolveAsymmetric(e, actual[i], seen)) : expected;
  if (Object.getPrototypeOf(expected) !== Object.prototype && Object.getPrototypeOf(expected) !== null) return expected;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(expected)) out[k] = resolveAsymmetric((expected as Record<string, unknown>)[k], (actual as Record<string, unknown>)[k], seen);
  return out;
}

/** The diff block for a failed comparison, or undefined when a diff would not help. */
export function valueDiff(expected: unknown, received: unknown, colors: Colors = plain): string | undefined {
  if (typeof expected === 'string' && typeof received === 'string') {
    if (!expected.includes('\n') && !received.includes('\n') && expected.length < 40 && received.length < 40) return renderDiff(JSON.stringify(expected), JSON.stringify(received), colors);
    return renderDiff(expected, received, colors);
  }
  const simple = (v: unknown) => v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol';
  if (simple(expected) && simple(received)) return undefined;
  const e = pretty(resolveAsymmetric(expected, received));
  const r = pretty(received);
  if (e === r) {
    return equals(expected, received) ? undefined : `${colors.dim('Compared values serialize to the same structure: they differ in type, class, -0 / +0 or identity.')}\n\n${renderDiff(e, r, colors)}`;
  }
  return renderDiff(e, r, colors);
}
