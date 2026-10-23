# EZTest in VS Code (and other editors)

EZTest ships a language server for `.ez` journeys and a VS Code extension built on it. You get the same language services as EZTest Studio's editor: diagnostics, completion, hover docs and formatting all come from the grammar, the validator and the Studio language services. The editor, Studio and the runner therefore agree on what every line means.

## The language server: `eztest lsp`

```bash
npx eztest lsp --stdio      # LSP over stdin/stdout; run it from the project root
```

Any LSP client can use it (Neovim, Emacs, Sublime, IntelliJ with an LSP plugin). The server reads `eztest.config.yaml` (roles, database connections, document checks, data entities), the journeys under `journeysDir` and the named queries under `db.queries.dir` (default `queries/`).

| Feature | What it does |
|---|---|
| Diagnostics | Every line that does not parse, with the closest phrasing. It also warns about unknown roles (`Log in as manger`), journeys (`Run journey "..."`), named queries, database connections and document checks, each with a "did you mean". YAML and JSON journeys are validated too. |
| Quick fixes | "Use "…"" replaces the line with the closest phrasing, or replaces an unknown name with the closest known one. |
| Completion | Phrasings (as snippets with the quoted parts as placeholders) and Expect phrasings. It also completes headers, roles after `Log in as` / `Role:` / `Call API … as`, journeys inside `Run journey "`, named queries inside `query "`, `${variables}`, tags, lenses, data entities, DB connections and document checks. |
| Hover | What a line does: action, target, value, what it stores and the grammar rule. It also lists the checks of the Expect lines below it. Hover over a role, a named query (shows its SQL), a journey reference or a `${variable}` to see where it comes from. |
| Go to definition | `Run journey "x"` goes to the journey file, `query "NAME"` to `queries/NAME.sql`, and a role, connection or document check to its entry in `eztest.config.yaml`. A `${variable}` or a bare name in an expression goes to its definition: the `Variables:` or `Params:` header, `Set variable`, `as <name>` captures, `For each <name>`, `Data:` aliases or an Examples column. |
| Outline | Headers, then steps, with their Expect lines and If/Repeat/For each/… blocks nested. |
| Formatting | The Studio formatter (header casing, one blank line before the steps, Expect lines indented). |
| Rename | Variables: every `${name}` plus the definitions and bare names in expressions (`Set variable doubled to total * 2`). Journeys: rename the `Journey:` (or `Id:`) header and every `Run journey` reference in the workspace follows. A reference by a derived id is updated to the new derived id. |
| `eztest/journeys` | Custom request: the workspace journeys with their top-level steps, used by the Test Explorer. |

The protocol is tested by driving the real CLI over stdio (`test/lsp/lsp-stdio.test.ts`).

## The VS Code extension

The extension lives in `editors/vscode/`:

- **Syntax highlighting.** A TextMate grammar (`syntaxes/ez.tmLanguage.json`) covers headers, the step verb, Expect lines, flow keywords, quoted text, `${variables}`, `<example columns>`, locators (`testid=…`), URLs, numbers, captures (`as name`), `[optional timeout=5s]` annotations, comments and Examples tables.
- **Language client.** The extension starts `eztest lsp` from the workspace (`node_modules/.bin/eztest`), or from the `eztest.cliPath` setting. If neither is found it falls back to `npx --no-install eztest`.
- **Test Explorer** (VS Code Testing API). Every journey and its steps appear in the Testing view and as gutter icons. Library journeys (`@library`) are left out because they run from their callers.
  - The **Run** profile calls `eztest run <file> --reporter json`.
  - The **Debug** profile adds `--headed --trace`.
  - Results come from the run's `run.json`: journey and step pass/fail, and failure messages placed on the failing step. The run's console output streams into the test output.
- **Commands.**
  - *EZTest: Run journey* and *EZTest: Debug journey*, from the editor title or the explorer context menu.
  - *EZTest: Validate journeys*, which runs `eztest validate` in a terminal.
  - *EZTest: Open EZTest Studio*, which starts `eztest studio --no-open` and opens its tokenised URL.
  - *EZTest: Restart the .ez language server*.
- **Settings.**
  - `eztest.cliPath`: the CLI to call.
  - `eztest.runArgs`: extra `eztest run` arguments, for example `["--env", "qa"]`.
  - `eztest.trace.server`: LSP tracing.

### Build and install

```bash
cd editors/vscode
npm install                # vscode-languageclient, esbuild, @vscode/vsce, typings
npm run typecheck
npm run package            # esbuild bundle -> dist/extension.js, then vsce -> eztest-vscode.vsix
code --install-extension eztest-vscode.vsix
```

`npm run package` bundles the extension and `vscode-languageclient` into a single `dist/extension.js`. The `.vsix` therefore holds only that bundle, the manifest, the grammar and the language configuration, about 120 KB. `test/lsp/vscode-extension.test.ts` covers three things:

- It tokenizes `.ez` with the grammar on the real Oniguruma engine (`vscode-textmate`).
- It checks that the manifest's commands are registered in the code.
- It packages the `.vsix` and inspects its contents.

The last two tests are skipped when `npm install` has not been run in `editors/vscode`.

To debug the extension itself, open `editors/vscode` in VS Code and start an *Extension Development Host* with F5, using a launch configuration of type `extensionHost`.
