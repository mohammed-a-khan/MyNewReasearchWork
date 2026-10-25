/**
 * `@eztech.com/eztest/plugins`: the stable plugin API. See docs/plugins.md.
 *
 *   import { definePlugin } from '@eztech.com/eztest/plugins';
 *   export default definePlugin({ name: '@acme/eztest-sap', apiVersion: 1, setup(api) { ... } });
 */
export { definePlugin, PLUGIN_API_VERSION, compilePhrase, type EzPlugin, type PluginApi, type CustomStepDef } from './api.js';
export { loadPlugins, checkPlugin, registerFirstPartyPlugins, type LoadedPlugins, type PluginSpec } from './load.js';
export { runPublishers, type PublisherSpec } from './publish.js';
export {
  registries, pluginSteps, pluginLoginRecipe,
  type Reporter, type Publisher, type PublishContext, type PublishResult, type LoginRecipe, type LensFactory, type StudioPage, type CommandHook, type RunAnalysis,
} from './registry.js';
export { slackPlugin, teamsPlugin } from './publishers/index.js';
export type { IntentRule, StepBody } from '../intent/index.js';
export type { CustomStepHandler, StepContext, Lens, LensFinding } from '../runner/types.js';
export type { DataProvider } from '../data/providers.js';
export type { ImporterPlugin, ImporterContext, ImportReport } from '../importers/types.js';
export type { SecretStore, Logger, RunResult, Journey, Step } from '../core/index.js';
export type { RouteDef, RouteContext, RouteResponse } from '../studio/routes/types.js';
