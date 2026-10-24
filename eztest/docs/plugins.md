# Plugins

`@mohammed-a-khan/eztest/plugins` is the stable, typed surface for organisation-specific extensions. A plugin can add:

- custom steps with their own plain-English phrasing;
- lenses, reporters, secret stores, test data providers and login recipes;
- CLI commands, Studio routes and Studio pages;
- test importers: source formats for `eztest import --from <name>` and Studio's import page;
- result publishers (the first-party ones are Jira, Slack and Teams; Azure DevOps has its own module).

## Writing a plugin

```js
// plugins/acme.mjs  (or an npm package, e.g. @acme/eztest-erp)
import { definePlugin } from '@mohammed-a-khan/eztest/plugins';

export default definePlugin({
  name: '@acme/eztest-erp',
  version: '1.2.0',
  apiVersion: 1,                     // the plugin API this was written for
  setup(api, options) {
    api.registerStep({
      name: 'acme.approve-invoice',
      phrase: ['Approve invoice {invoice} as {approver}', 'Approve {invoice}'],
      example: 'Approve invoice "INV-7" as controller',
      async run(page, args, ctx) {
        await page.goto(`${ctx.baseUrl}/invoices/${args.invoice}`);
        await page.getByRole('button', { name: 'Approve' }).click();
        return { approvedBy: args.approver ?? options.defaultApprover };   // stored in the ledger
      },
    });
  },
});
```

Load the plugin in `eztest.config.yaml`:

```yaml
plugins:
  - ./plugins/acme.mjs                         # a local path (relative to the project)
  - "@acme/eztest-erp"                         # an npm package installed in the project
  - { name: "@acme/eztest-sso", options: { tenant: acme } }
```

Plugins are loaded before journeys are parsed, so their phrasings validate and run like the built-in ones. `eztest doctor` lists the loaded plugins and fails on any that do not load.

## API version check

`PLUGIN_API_VERSION` is currently 1. It changes only when `PluginApi` changes in a breaking way, independently of the package version. A plugin declares the version it targets. EZTest refuses to load a plugin written for another version and says what to do:

```
Plugin future-plugin targets plugin API v2, but this EZTest provides v1. Upgrade EZTest, or use an older version of the plugin.
```

A plugin without `apiVersion`, or a module that does not export a plugin, is refused too.

## The API

| Method | Extends | Notes |
|---|---|---|
| `registerStep({ name, phrase, run })` | Custom steps and phrasings | `{arg}` captures a word or a quoted value. Wraps `registerIntentRules`, so plugin phrasings are tried before the built-in grammar. `run(page, args, ctx, step)` returns values for the ledger |
| `registerPhrasings(rules)` | Raw intent rules | Full control: `{ name, keywords, example, re, build(m, quotes) }` |
| `registerStepHandler(name, fn)` | `action: custom, handler: <name>` | For YAML/JSON journeys and your own phrasings |
| `registerLens(name, factory)` | `lenses: [name]`, `--lens name[:warn]` | `factory({ cwd, mode, updateBaselines })` returns a runner lens |
| `registerReporter({ name, write })` | `reporters: [name]`, `--reporter name` | `write({ run, runDir, analysis })` returns the files written |
| `registerSecretStore(store)` | `secret://<store.name>/<key>` | Any `{ name, get(key) }`, for example HashiCorp Vault or CyberArk |
| `registerDataProvider(provider)` | Test Data Fabric | A `DataProvider` that declares which entities it `supports` |
| `registerLoginRecipe({ name, roles, login })` | Identity | Signs in the listed roles (or a predicate). Every other role uses the Identity Vault |
| `registerCommand((program, io) => ...)` | `eztest <command>` | commander `Command` API |
| `registerStudioRoutes(routes)` | Studio API | `RouteDef[]`, authenticated like every Studio route |
| `registerStudioPage({ id, title, render })` | Studio activity bar | HTML rendered by the plugin, shown in a frame with no scripts |
| `registerPublisher({ name, publish })` | `publishers: [{ use: name }]`, `eztest publish` | See below |
| `registerImporter({ name, detect?, import })` | `eztest import --from name`, Studio's import page | See [Importer plugins](#importer-plugins) |

Every registration is tracked and undone when the plugin is unloaded, for example in tests or on a Studio reload.

## Publishers

Publishers run after `eztest run`, after `eztest merge --publish`, and on `eztest publish <runDir>`. Configure them in `eztest.config.yaml`:

```yaml
publishers:
  - { use: slack, webhook: secret://env/SLACK_WEBHOOK, when: failed, title: Payments }
  - { use: teams, webhook: secret://env/TEAMS_WEBHOOK }
  - use: jira
    baseUrl: https://acme.atlassian.net
    email: qa-bot@acme.com
    apiToken: secret://env/JIRA_TOKEN          # Data Center: token: secret://env/JIRA_PAT
    projectKey: PAY
    categories: [product-bug, unknown]         # which triage categories become bugs
```

`when` is `always` (the default), `failed` or `passed`. Secret references are resolved through the Identity Vault and masked in logs.

`eztest publish <runDir> --dry-run` shows, for each publisher, the requests it would send, and sends nothing.

| Publisher | Maps journeys by | Sends |
|---|---|---|
| `slack` | the whole run | A summary with counts, readiness, the failed journeys and a link to the run |
| `teams` | the whole run | An Adaptive Card with the same content |
| `jira` | failure signature | One bug per signature (label `ezsig-<hash>`) with steps, error, triage and evidence ids. The failing step's evidence is attached and the run is linked. A repeat failure adds a comment instead of filing a duplicate |

### Jira requirements traceability

```bash
eztest jira requirements --jql 'project = PAY AND issuetype = Story AND fixVersion = "2026.11"'
```

This command uses the `jira` publisher's connection. It lists every requirement the JQL returns that no journey covers, or that is covered only by failing or quarantined journeys, using the journeys' `Requirements:` headers and their latest results.

## Importer plugins

An importer plugin teaches the Migration Factory a new source format, for example a private or in-house test framework. Such importers live outside EZTest: keep them in your own repository or a private registry and load them as plugins.

```js
// importers/acme-steps.mjs  (or an npm package, e.g. @acme/eztest-importer-steps)
import { readFile } from 'node:fs/promises';
import { definePlugin } from '@mohammed-a-khan/eztest/plugins';
import { JourneyDraft, assembleReport } from '@mohammed-a-khan/eztest/importers';

export default definePlugin({
  name: '@acme/eztest-importer-steps',
  apiVersion: 1,
  setup(api) {
    api.registerImporter({
      name: 'acme-steps',                         // eztest import --from acme-steps
      title: 'ACME step files',                   // label in Studio
      extensions: ['.steps'],                     // files Studio's picker lets you choose
      detect: (paths) => paths.every((p) => p.endsWith('.steps')),   // optional: claim files during auto-detection
      async import(paths, ctx) {
        const drafts = [];
        for (const file of paths) {
          const d = new JourneyDraft(file, { kind: 'acme-steps', file, line: 1, ids: ctx.ids, tags: ctx.tags });
          (await readFile(file, 'utf8')).split('\n').forEach((line, i) => {
            if (line.trim()) d.english(line.trim(), { line: i + 1, original: line });   // EZ grammar; TODO when not understood
          });
          drafts.push(d);
        }
        return assembleReport(drafts, paths, []);
      },
    });
  },
});
```

Load it from `eztest.config.yaml`, or for one import with `--plugin`:

```yaml
importers:
  plugins: [./importers/acme-steps.mjs]       # npm package names work too
  options:
    acme-steps: { strict: true }              # ctx.options for that importer
```

```bash
eztest import tests/ --from acme-steps -o journeys/imported --verify
eztest import tests/ --plugin ./importers/acme-steps.mjs --from acme-steps --importer-option strict
```

- `import(paths, ctx)` gets the paths as given (directories included) and returns an `ImportReport`. `ctx` has `cwd`, `outDir`, `tags`, `ids` (journey ids already taken) and `options`: `importers.options.<name>` from config, overridden by `--importer-option key=value` (a bare `key` is `true`).
- EZTest writes the journeys, `import-report.json` and `import-report.md`, and replays them with `--verify`, exactly as for the built-in importers. `report.assets` are extra files written next to the journeys, `report.diagnostics` are problems in the source suite, `report.summary` goes into the JSON report and `report.markdown` lines into the Markdown one.
- Without `--from` or `--kind`, every importer plugin with a `detect` function is asked first; the first that claims the paths imports all of them. Otherwise the built-in importers detect formats per file.
- `@mohammed-a-khan/eztest/importers` exports the building blocks: `JourneyDraft` (EZ lines through the grammar, TODO lines with reasons, coverage), `importGherkin` with its `convertStep`, `rewrite` and `externalExamples` hooks (for Cucumber dialects), `assembleReport` / `mergeReports`, and `loadTypeScript` to read TypeScript sources with the compiler API.
- Studio lists plugin formats in the import page's Format menu (`GET /api/import/formats`) and loads `importers.plugins` when it starts.
- A plugin may register an `eztest` command too (`registerCommand`), for example to convert the framework's configuration files. Commands of plugins listed in `importers.plugins` are available like any other.

## Testing a plugin

Load it in a test with `loadPlugins([...], { cwd })`. Call `off()` when the test is done. `registries` exposes what the plugin registered. For an importer plugin, call `importFiles(paths, { from: '<name>' })` from `@mohammed-a-khan/eztest/importers`, or run `eztest import --plugin <path> --from <name>` (`test/importers/plugin-importer.test.ts` does both with a sample importer). The first-party publishers in `src/plugins/publishers/` are written against this same API and are tested against mock HTTP servers. They make good templates.
