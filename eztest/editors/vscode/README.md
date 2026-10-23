# EZTest for VS Code

Write, check and run EZTest journeys (`.ez`) without leaving VS Code.

- **Language server** (`eztest lsp`): diagnostics with the closest phrasing and a quick fix, warnings for unknown roles, journeys, named queries, connections and document checks, completion of phrasings, roles, journeys, named queries and variables, hover docs, go to definition, outline, formatting and rename of variables and journeys.
- **Syntax highlighting** for headers, steps, Expect lines, flow blocks, quoted text, `${variables}`, `<example columns>`, locators and annotations.
- **Test Explorer**: every journey in the workspace, with its steps, through the VS Code Testing API. Run it, or debug it (headed browser with a trace). Failures point at the failing step.
- **Commands**: *EZTest: Run journey*, *Debug journey*, *Validate journeys*, *Open EZTest Studio*, *Restart the .ez language server*.

The extension calls the `eztest` CLI of the workspace (`node_modules/.bin/eztest`), or the `eztest.cliPath` setting. See `docs/vscode.md` in the EZTest package for details and how to build the `.vsix`.
