/**
 * The EZTest plugin API (`eztest/plugins`): a stable, typed surface for
 * organisation-specific extensions. A plugin is a module whose default export
 * (or `plugin` export) is `definePlugin({ name, apiVersion: 1, setup(api) })`.
 *
 * Stability: everything reachable from `PluginApi` follows the plugin API
 * version (PLUGIN_API_VERSION), not the package version. A plugin declares the
 * version it was written for; EZTest refuses to load a plugin for another API
 * major version, with a clear message, instead of failing later at run time.
 */
import type { Page } from '../browser/index.js';
import type { Logger, SecretStore, Step } from '../core/index.js';
import { registerIntentRules, type IntentRule } from '../intent/index.js';
import { literal } from '../intent/quotes.js';
import type { CustomStepHandler, StepContext } from '../runner/types.js';
import type { DataProvider } from '../data/providers.js';
import type { RouteDef } from '../studio/routes/types.js';
import { EZTEST_VERSION } from '../ops/version.js';
import { BUILTIN_IMPORT_KINDS, type ImporterPlugin } from '../importers/types.js';
import { registries, type CommandHook, type LensFactory, type LoginRecipe, type Publisher, type Reporter, type StudioPage } from './registry.js';

/** The plugin API version this EZTest provides. Bumped only for breaking changes to PluginApi. */
export const PLUGIN_API_VERSION = 1;

export interface PluginApi {
  /** Plugin API version provided (see PLUGIN_API_VERSION). */
  readonly apiVersion: number;
  /** EZTest package version. */
  readonly eztestVersion: string;
  /** Project directory. */
  readonly cwd: string;
  readonly logger: Logger;

  /**
   * A custom step with its own plain-English phrasing. `{name}` placeholders capture a word or a quoted value:
   * `phrase: 'Approve invoice {invoice} as {approver}'` matches `Approve invoice "INV-7" as finance`.
   */
  registerStep(def: CustomStepDef): void;
  /** Raw phrasings (intent rules) for full control; tried before the built-in grammar. */
  registerPhrasings(rules: IntentRule[]): void;
  /** A custom step handler used by `action: custom, handler: <name>` (YAML) or by your phrasings. */
  registerStepHandler(name: string, handler: CustomStepHandler): void;
  /** A lens usable in `lenses:` / `--lens <name>` (":warn" suffix supported). */
  registerLens(name: string, factory: LensFactory): void;
  /** A reporter usable in `reporters:` / `--reporter <name>`. */
  registerReporter(reporter: Reporter): void;
  /** A secret store, addressed as `secret://<store.name>/<key>`. */
  registerSecretStore(store: SecretStore): void;
  /** A test data provider for the Test Data Fabric (`Data: <entity> as x where ...`). */
  registerDataProvider(provider: DataProvider): void;
  /** A login recipe for some roles (SSO flows the built-in recipes do not cover). */
  registerLoginRecipe(recipe: LoginRecipe): void;
  /** Extra `eztest` CLI commands. */
  registerCommand(hook: CommandHook): void;
  /** Extra Studio API routes (authenticated like every Studio route). */
  registerStudioRoutes(routes: RouteDef[]): void;
  /** A Studio page (HTML rendered by the plugin, shown in a sandboxed frame). */
  registerStudioPage(page: StudioPage): void;
  /** A result publisher usable in `publishers: [{ use: <name> }]`. */
  registerPublisher(publisher: Publisher): void;
  /** A test source format for `eztest import --from <name>` and Studio's import page (see ImporterPlugin). */
  registerImporter(importer: ImporterPlugin): void;
}

export interface CustomStepDef {
  /** Handler name (unique), e.g. "acme.approve-invoice". */
  name: string;
  /** One or more phrasings with `{arg}` placeholders. */
  phrase: string | string[];
  /** Example line for suggestions and the Studio palette. */
  example?: string;
  category?: string;
  run(page: Page, args: Record<string, string>, ctx: StepContext, step: Step): Promise<Record<string, unknown> | void>;
}

export interface EzPlugin {
  /** Package-style name, e.g. "@acme/eztest-plugin-sap". */
  name: string;
  /** Plugin API version the plugin was written against. */
  apiVersion: number;
  version?: string;
  setup(api: PluginApi, options: Record<string, unknown>): void | Promise<void>;
}

/** Identity helper that gives plugin authors type checking. */
export function definePlugin(plugin: EzPlugin): EzPlugin {
  return plugin;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compile `Approve invoice {invoice} as {role}` into an intent rule regex and its argument names. */
export function compilePhrase(phrase: string): { re: RegExp; args: string[] } {
  const args: string[] = [];
  const parts = phrase.trim().split(/(\{[A-Za-z_][\w]*\})/);
  const src = parts
    .map((p) => {
      const m = /^\{([A-Za-z_]\w*)\}$/.exec(p);
      if (m) {
        args.push(m[1]);
        return '(⟦\\d+⟧|\\S+)';
      }
      return p.split(/\s+/).map(esc).join('\\s+');
    })
    .join('');
  return { re: new RegExp(`^${src}\\s*$`, 'i'), args };
}

/** Build the PluginApi for one plugin; every registration is tracked so it can be undone. */
export function createPluginApi(o: { cwd: string; logger: Logger; offs: Array<() => void> }): PluginApi {
  const track = (off: () => void) => o.offs.push(off);
  return {
    apiVersion: PLUGIN_API_VERSION,
    eztestVersion: EZTEST_VERSION,
    cwd: o.cwd,
    logger: o.logger,
    registerStep(def) {
      if (!def.name || typeof def.run !== 'function') throw new Error('registerStep: name and run are required');
      const phrases = Array.isArray(def.phrase) ? def.phrase : [def.phrase];
      const rules: IntentRule[] = phrases.map((phrase, i) => {
        const { re, args } = compilePhrase(phrase);
        return {
          name: `plugin:${def.name}:${i}`,
          keywords: [phrase.split(/\s+/)[0].toLowerCase()],
          example: def.example ?? phrase,
          category: def.category ?? 'Plugins',
          re,
          build: (m, q) => ({ action: 'custom', handler: def.name, args: Object.fromEntries(args.map((a, k) => [a, literal(m[k + 1] ?? '', q)])) }),
        };
      });
      track(registerIntentRules(rules));
      track(registries.steps.add(def.name, async (page, step, ctx) => def.run(page, Object.fromEntries(Object.entries(step.args ?? {}).map(([k, v]) => [k, ctx.interpolate(String(v))])), ctx, step)));
    },
    registerPhrasings: (rules) => track(registerIntentRules(rules)),
    registerStepHandler: (name, handler) => track(registries.steps.add(name, handler)),
    registerLens: (name, factory) => track(registries.lenses.add(name, factory)),
    registerReporter: (r) => track(registries.reporters.add(r.name, r)),
    registerSecretStore: (s) => track(registries.secretStores.add(s.name, s)),
    registerDataProvider: (p) => track(registries.dataProviders.add(p.name, p)),
    registerLoginRecipe: (r) => track(registries.loginRecipes.add(r.name, r)),
    registerCommand: (h) => track(registries.commands.add(`cmd-${o.offs.length}-${Math.random().toString(36).slice(2, 8)}`, h)),
    registerStudioRoutes: (routes) => track(registries.studioRoutes.add(`routes-${o.offs.length}-${Math.random().toString(36).slice(2, 8)}`, routes)),
    registerStudioPage: (p) => track(registries.studioPages.add(p.id, p)),
    registerPublisher: (p) => track(registries.publishers.add(p.name, p)),
    registerImporter(imp) {
      if (!imp || !/^[a-z0-9][a-z0-9._-]*$/i.test(imp.name ?? '') || typeof imp.import !== 'function') {
        throw new Error('registerImporter: a name (letters, digits, ".", "_" or "-") and an import(paths, ctx) function are required');
      }
      if ((BUILTIN_IMPORT_KINDS as readonly string[]).includes(imp.name)) throw new Error(`registerImporter: "${imp.name}" is a built-in import format`);
      track(registries.importers.add(imp.name, imp));
    },
  };
}
