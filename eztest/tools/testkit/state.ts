/**
 * The test tree of the file being collected / run in this worker process.
 */
export type Mode = 'run' | 'skip' | 'only' | 'todo';
export type Awaitable<T> = T | Promise<T>;

export interface TestOptions {
  /** Per-test (or, on a describe, per-test-inside) timeout in ms. */
  timeout?: number;
  /** Extra attempts after a failure. */
  retry?: number;
  /** Accepted for compatibility with test titles that carry tags; not interpreted. */
  tags?: string[];
  skip?: boolean;
  only?: boolean;
  todo?: boolean;
}

export interface Hook {
  fn: (...args: unknown[]) => unknown;
  timeout?: number;
  /** Where the hook was declared (its stack is formatted only when a report needs it). */
  site?: Error;
}

export interface SuiteNode {
  kind: 'suite';
  name: string;
  parent?: SuiteNode;
  mode: Mode;
  options: TestOptions;
  factory?: () => unknown;
  children: Array<SuiteNode | TestNode>;
  hooks: { beforeAll: Hook[]; afterAll: Hook[]; beforeEach: Hook[]; afterEach: Hook[] };
}

export interface TestNode {
  kind: 'test';
  name: string;
  parent: SuiteNode;
  mode: Mode;
  options: TestOptions;
  fn?: (ctx: TestContext) => unknown;
  /** Where the test was declared (its stack is formatted only when a report needs it). */
  site?: Error;
}

export interface TestContext {
  /** Skips the running test (it is reported as skipped). */
  skip(note?: string): never;
  /** Runs after the test (and its afterEach hooks), pass or fail. */
  onTestFinished(fn: () => unknown): void;
  /** Runs after the test when it failed. */
  onTestFailed(fn: () => unknown): void;
  task: { name: string; fullName: string; file: string };
  /** Aborted when the test times out. */
  signal: AbortSignal;
}

export interface RunningTest {
  node: TestNode;
  softErrors: unknown[];
  onFinished: Array<() => unknown>;
  onFailed: Array<() => unknown>;
}

export class SkipSignal extends Error {
  constructor(readonly note?: string) {
    super(note ? `skipped: ${note}` : 'skipped');
    this.name = 'SkipSignal';
  }
}

export function newSuite(name: string, parent: SuiteNode | undefined, mode: Mode, options: TestOptions = {}, factory?: () => unknown): SuiteNode {
  return { kind: 'suite', name, parent, mode, options, factory, children: [], hooks: { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] } };
}

export const state: {
  file?: string;
  root?: SuiteNode;
  current?: SuiteNode;
  running?: RunningTest;
  collecting: boolean;
  color: boolean;
} = { collecting: false, color: false };

export function currentSuite(what: string): SuiteNode {
  if (!state.current) throw new Error(`${what}() was called outside of a test file being collected by the EZTest testkit runner (run the file with \`npm test\`).`);
  if (!state.collecting) throw new Error(`${what}() was called while tests are running; declare tests and hooks at the top level or inside describe().`);
  return state.current;
}
