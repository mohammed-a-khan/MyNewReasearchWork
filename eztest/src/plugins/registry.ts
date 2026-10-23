/**
 * Process-wide extension registries filled by plugins. The engine, the CLI
 * and the Studio read from here; nothing here imports those modules, so any
 * module can consult the registries without import cycles.
 */
import type { Page } from '../browser/index.js';
import type { RunResult, SecretStore, Logger } from '../core/index.js';
import type { CustomStepHandler, Lens } from '../runner/types.js';
import type { DataProvider } from '../data/providers.js';
import type { RouteDef } from '../studio/routes/types.js';
import type { FlakyScore, ReadinessResult, TriageReport } from '../insights/index.js';
import type { ImporterPlugin } from '../importers/types.js';

export interface RunAnalysis {
  triage?: TriageReport;
  readiness?: ReadinessResult;
  flaky?: FlakyScore[];
}

/** A reporter writes extra report files into the run directory. Returns the files it wrote. */
export interface Reporter {
  name: string;
  write(ctx: { run: RunResult; runDir: string; analysis: RunAnalysis }): Promise<string[]> | string[];
}

export interface PublishContext {
  run: RunResult;
  runDir: string;
  analysis: RunAnalysis;
  /** The publisher's options from `publishers:` (secret references not yet resolved: use resolveSecret). */
  options: Record<string, unknown>;
  /** Resolve `secret://store/key` (and pass other values through). Resolved values are masked in logs. */
  resolveSecret(value: string): Promise<string>;
  /** Link to the run on the results server, when it was published there. */
  runUrl?: string;
  fetch: typeof fetch;
  logger: Logger;
}

export interface PublishResult {
  ok: boolean;
  message: string;
  details?: unknown;
}

/** A result publisher: Slack, Teams, Jira, or one a plugin registers. */
export interface Publisher {
  name: string;
  publish(ctx: PublishContext): Promise<PublishResult>;
}

/** A login recipe for roles the built-in form/Entra recipes cannot handle. */
export interface LoginRecipe {
  name: string;
  /** Roles this recipe signs in (a list, or a predicate). */
  roles: string[] | ((role: string) => boolean);
  login(page: Page, role: string, ctx: unknown): Promise<void>;
}

export type LensFactory = (o: { cwd: string; mode: 'error' | 'warning'; updateBaselines?: boolean }) => Lens;

/** A page in the Studio (rendered by the plugin, shown in a sandboxed frame). */
export interface StudioPage {
  id: string;
  title: string;
  render(ctx: { cwd: string; query: URLSearchParams }): Promise<string> | string;
}

/** CLI command hook: receives the commander program and the CLI I/O. */
export type CommandHook = (program: import('commander').Command, io: { out(s: string): void; err(s: string): void; cwd: string; env: Record<string, string | undefined> }) => void;

class Registry<T> {
  private readonly items = new Map<string, T>();
  add(name: string, item: T): () => void {
    this.items.set(name, item);
    return () => {
      if (this.items.get(name) === item) this.items.delete(name);
    };
  }
  get(name: string): T | undefined {
    return this.items.get(name);
  }
  list(): T[] {
    return [...this.items.values()];
  }
  names(): string[] {
    return [...this.items.keys()];
  }
}

export const registries = {
  steps: new Registry<CustomStepHandler>(),
  lenses: new Registry<LensFactory>(),
  reporters: new Registry<Reporter>(),
  secretStores: new Registry<SecretStore>(),
  dataProviders: new Registry<DataProvider>(),
  loginRecipes: new Registry<LoginRecipe>(),
  commands: new Registry<CommandHook>(),
  studioRoutes: new Registry<RouteDef[]>(),
  studioPages: new Registry<StudioPage>(),
  publishers: new Registry<Publisher>(),
  importers: new Registry<ImporterPlugin>(),
};

/** Custom step handlers from plugins, keyed by handler name. */
export function pluginSteps(): Record<string, CustomStepHandler> {
  return Object.fromEntries(registries.steps.names().map((n) => [n, registries.steps.get(n)!]));
}

export function pluginLoginRecipe(role: string): LoginRecipe | undefined {
  return registries.loginRecipes.list().find((r) => (Array.isArray(r.roles) ? r.roles.includes(role) : r.roles(role)));
}
