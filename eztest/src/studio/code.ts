/**
 * Code files in the Studio (eztest/sdk): code journeys (`*.journey.ts`), code
 * steps (`*.steps.ts`) and screens (`screens/*.ts`). The Studio lists them,
 * opens them with TypeScript highlighting, checks their syntax, and runs and
 * debugs code journeys. Listing reads the text only (a static scan of
 * `journey()` calls); modules are loaded only when a run or debug session
 * starts, exactly like `eztest run`.
 */
import { slugify } from '../core/index.js';
import { CODE_JOURNEY_RE, CODE_STEPS_RE } from '../runner/code-journeys.js';
import type { ValidationResult } from './authoring.js';

/** Code files the Studio may open and save. */
export function isCodePath(p: string): boolean {
  const posix = p.replace(/\\/g, '/');
  return CODE_JOURNEY_RE.test(posix) || CODE_STEPS_RE.test(posix) || /(?:^|\/)screens\/[^/]+\.(?:ts|mts)$/i.test(posix)
    // Gherkin step definition folders (docs/bdd.md).
    || /(?:^|\/)step[_-]definitions\/(?:[^/]+\/)*[^/]+\.(?:ts|mts|js|mjs)$/i.test(posix);
}

export interface CodeJourneyInfo {
  id: string;
  name: string;
  /** 1-based line of the journey() call. */
  line: number;
  tags: string[];
  requirements: string[];
  risk?: number;
  /** The options object sets `id` (otherwise the id is the slug of the name). */
  explicitId?: boolean;
}

const STR = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|\x60((?:[^\x60\\$]|\\.)*)\x60)`;
const JOURNEY_CALL = new RegExp(String.raw`(?:^|[^\w.$])journey\s*\(\s*${STR}\s*(,\s*\{)?`, 'g');

/** journey() calls in a code file, found by reading the text (nothing is executed). */
export function scanCodeJourneys(text: string): CodeJourneyInfo[] {
  const out: CodeJourneyInfo[] = [];
  for (const m of text.matchAll(JOURNEY_CALL)) {
    const name = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
    if (!name) continue;
    const at = m.index ?? 0;
    const line = text.slice(0, at + m[0].indexOf('journey')).split('\n').length;
    // Options object (best effort): `id: '...'` and `tags: [...]` before the callback.
    const opts = m[4] ? text.slice(at + m[0].length, at + m[0].length + 600).split(/\basync\b|=>/)[0] : '';
    const explicit = /\bid\s*:\s*['"`]([^'"`]+)['"`]/.exec(opts)?.[1];
    const id = explicit ?? slugify(name);
    const tagsText = /\btags\s*:\s*\[([^\]]*)\]/.exec(opts)?.[1] ?? '';
    const tags = [...tagsText.matchAll(/['"`]@?([^'"`]+)['"`]/g)].map((t) => t[1]);
    const reqText = /\brequirements\s*:\s*\[([^\]]*)\]/.exec(opts)?.[1] ?? '';
    const requirements = [...reqText.matchAll(/['"`]([^'"`]+)['"`]/g)].map((t) => t[1]);
    const risk = Number(/\brisk\s*:\s*([1-5])\b/.exec(opts)?.[1] ?? NaN);
    out.push({ id, name, line, tags, requirements, ...(Number.isFinite(risk) ? { risk } : {}), ...(explicit ? { explicitId: true } : {}) });
  }
  return out;
}

type Esbuild = typeof import('esbuild');
let esbuildP: Promise<Esbuild | undefined> | undefined;

/** Syntax check of TypeScript text (esbuild when available), with line and column. Type errors are for `tsc`. */
export async function validateCode(text: string, path = 'file.ts'): Promise<ValidationResult> {
  esbuildP ??= import('esbuild').then((m) => ((m as unknown as { default?: Esbuild }).default?.transform ? (m as unknown as { default: Esbuild }).default : m)).catch(() => undefined);
  const esbuild = await esbuildP;
  if (esbuild) {
    try {
      await esbuild.transform(text, { loader: /\.m?js$/i.test(path) ? 'js' : 'ts', sourcefile: path, logLevel: 'silent' });
    } catch (e) {
      const errors = ((e as { errors?: Array<{ text: string; location?: { line: number; column: number } | null }> }).errors ?? []).map((x) => ({
        ...(x.location ? { line: x.location.line, column: x.location.column + 1 } : {}),
        message: x.text,
        suggestions: [],
      }));
      return { ok: false, errors: errors.length ? errors : [{ message: (e as Error).message, suggestions: [] }] };
    }
  }
  const js = scanCodeJourneys(text);
  return js.length
    ? { ok: true, errors: [], journey: { id: js[0].id, name: js[0].name, steps: js.length, tags: js[0].tags } }
    : { ok: true, errors: [] };
}

/** A new code journey file. */
export function codeJourneyTemplate(name: string): string {
  const clean = name.replace(/[\r\n'\\]+/g, ' ').trim() || 'New journey';
  return [
    "import { journey, step, expect } from '@eztech.com/eztest/sdk';",
    '',
    `journey('${clean}', { tags: ['@draft'], risk: 3 }, async ({ ui }) => {`,
    "  await step('Open the app', async () => {",
    "    await ui.open('/');",
    '  });',
    "  await expect.ui.page().toContainText('Welcome');",
    '});',
    '',
  ].join('\n');
}
