/** The `.ez` language server: LSP over stdio (`eztest lsp`) and its services. */
export { EzLanguageServer, startLanguageServer, SERVER_CAPABILITIES, type ServerOptions } from './server.js';
export { MessageReader, writeMessage, ErrorCodes, type Message } from './protocol.js';
export {
  diagnose, complete, hover, definition, documentSymbols, format, codeActions, prepareRename, rename, lineKinds, variableDefinitions, referencesOn,
  type Diagnostic, type CompletionItem, type DocumentSymbol, type CodeAction, type TextEdit, type WorkspaceEdit,
} from './services.js';
export { Workspace, journeyHeader, pathToUri, uriToPath, type Location, type Range, type Position, type JourneyInfo } from './workspace.js';
