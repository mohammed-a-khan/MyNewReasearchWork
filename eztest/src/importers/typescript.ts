/**
 * Lazy access to the TypeScript compiler API. `typescript` is a development
 * dependency of EZTest; code that reads TypeScript sources statically (screen
 * modules, importer plugins reading page objects) loads it on demand, with a
 * clear error when it is not installed.
 */
import type * as TS from 'typescript';

export type Ts = typeof TS;

let cached: Ts | undefined;

/** Load the `typescript` package (from the project or EZTest's own install). */
export async function loadTypeScript(): Promise<Ts> {
  if (cached) return cached;
  try {
    const mod = (await import('typescript')) as unknown as { default?: Ts } & Ts;
    cached = (mod.default ?? mod) as Ts;
    return cached;
  } catch {
    throw new Error(
      'Reading TypeScript sources needs the TypeScript compiler API. ' +
        'Install it next to EZTest ("npm install --save-dev typescript") and run the command again.',
    );
  }
}
