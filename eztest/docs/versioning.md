# Versioning and compatibility policy

EZTest follows [Semantic Versioning](https://semver.org/). The public surface is listed below, with what each kind of release may change.

| Surface | Patch (x.y.Z) | Minor (x.Y.0) | Major (X.0.0) |
|---|---|---|---|
| `.ez` language and journey YAML/JSON | fixes | new phrasings and fields | removed or changed phrasings, with an importer or `eztest convert` path |
| `eztest.config.*` (`configVersion`) | fixes | new optional keys | a new `configVersion` with a migration in `eztest upgrade-config` |
| CLI commands, flags and exit codes | fixes | new commands and flags | removed or renamed commands and flags |
| Package exports (`eztest`, `eztest/<module>`) | fixes | additions | removals and signature changes |
| Plugin API (`@eztech.com/eztest/plugins`, `PLUGIN_API_VERSION`) | fixes | additions | a new `PLUGIN_API_VERSION`; plugins for the old one are refused with a message |
| Run artifacts (`run.json`, evidence manifest, reports, history) | fixes | additive fields | format changes, which older runs still verify and analyse |
| Results server HTTP API (`/api/version` `apiVersion`) | fixes | additive endpoints and fields | a new `apiVersion` |

## Rules

- **Config versions.** Every breaking config change bumps `CONFIG_VERSION` and adds a `ConfigMigration` from N to N+1 in `src/ops/config-migrate.ts`. `eztest upgrade-config` applies the migrations in order. A config whose `configVersion` is newer than the installed EZTest is refused, never silently misread.
- **Plugin API.** `PLUGIN_API_VERSION` changes only for breaking changes to `PluginApi` or to the registry contracts. Additions do not bump it.
- **Evidence.** Evidence written by any 0.x or later release must keep verifying with every later release.
- **Deprecations.** Deprecated features produce a warning for at least one minor release before they are removed in a major release.
- **Changelog.** Every release is recorded in [CHANGELOG.md](../CHANGELOG.md).
- **Pre-1.0.** While the version is 0.x, minor releases may contain breaking changes. Each one is called out in the changelog and, for config, handled by `upgrade-config`.
