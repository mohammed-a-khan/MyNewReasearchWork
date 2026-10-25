# EZTest documentation

Start with the **[EZTest Project Guide](project-guide.md)**: how an EZTest project is laid out, named and written, the rules `eztest lint` enforces, and the pipeline `eztest init --template enterprise` writes.

## Writing tests

- [The `.ez` language](ez-language.md): plain-English journeys, every phrasing
- [Native BDD](bdd.md): Gherkin features with TypeScript step definitions
- [Code journeys](sdk.md): the TypeScript SDK
- [Shared element repository](elements.md)
- [Multi-actor journeys](multi-actor.md)
- [Component adapters](components.md): grids, combo boxes, date pickers and other widgets
- [Recording journeys](recording.md) and [journeys from captured user sessions](sessions.md)
- [Manual and hybrid testing](manual-testing.md)

## Data, back ends and integration

- [Configuration](configuration.md): layers, environments, projects, secrets, roles
- [Databases](databases.md): connections and the named-query catalogue
- [Shared test data](shared-data.md): the store, data pools, setup journeys
- [API contracts](api-contracts.md), [SOAP services](soap.md), [messaging and integration](messaging.md)
- [Documents](documents.md): PDF extraction, OCR and comparison
- [API security scan pack](api-security.md)

## Platforms

- [Browser driver](browser-driver.md): Chromium, Chrome, Edge, Electron and Firefox, cross-browser runs, remote browsers
- [Native mobile](mobile.md)
- [Desktop and legacy apps](desktop-and-legacy.md)
- Packaged apps: [SAP Fiori](apps/sap.md), [ServiceNow](apps/servicenow.md), [Workday](apps/workday.md), [Oracle](apps/oracle.md), [Power Apps](apps/powerapps.md)

## Running, reporting and releasing

- [Reliability](reliability.md): waiting, flakiness, lint, locators, dependencies
- [Running at scale](scale.md): shards, locks, selection
- [Pipelines](pipelines.md): CI, schedules and deployments
- [Azure DevOps](azure-devops.md) and [Git](git.md)
- [Reports](reports.md) and [coverage](coverage.md)
- [Accessibility](accessibility.md)
- [EZTest Load](load.md)
- [Results server](server.md)

## Tools and extension

- [EZTest Studio](studio.md), its [Quality Center](quality.md) and [debugger and trace](studio-debug-trace.md)
- [VS Code and the language server](vscode.md)
- [Plugins](plugins.md)
- [Packaging and operations](operations.md)
- [Versioning and compatibility](versioning.md)
- [Architecture](architecture.md)
