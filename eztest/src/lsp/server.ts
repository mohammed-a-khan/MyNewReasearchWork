/**
 * The `.ez` language server (`eztest lsp`, LSP over stdio).
 *
 * Diagnostics (parse errors with the closest phrasing, unknown roles,
 * journeys, named queries, connections and document checks), completion,
 * hover docs, go to definition (Run journey, named queries, roles,
 * connections, document checks, variables), document symbols, formatting,
 * quick fixes and rename of variables and journeys (across files).
 *
 * Custom request `eztest/journeys` lists the workspace journeys with their
 * steps, for test explorers.
 */
import { stdin, stdout } from 'node:process';
import type { Readable, Writable } from 'node:stream';
import { extname, resolve } from 'node:path';
import { ErrorCodes, MessageReader, writeMessage, type Message } from './protocol.js';
import { codeActions, complete, definition, diagnose, documentSymbols, format, formatOfUri, hover, prepareRename, rename, type Diagnostic } from './services.js';
import { pathToUri, uriToPath, Workspace, type Position } from './workspace.js';

export interface ServerOptions {
  input?: Readable;
  output?: Writable;
  /** Called on the "exit" notification (default: process.exit). */
  onExit?: (code: number) => void;
  /** Workspace root when the client sends none. */
  root?: string;
  log?: (s: string) => void;
}

interface TextDocumentParams {
  textDocument: { uri: string; text?: string; version?: number };
  position?: Position;
  contentChanges?: Array<{ text: string; range?: unknown }>;
  context?: { diagnostics?: Diagnostic[] };
  newName?: string;
}

export const SERVER_CAPABILITIES = {
  textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
  completionProvider: { triggerCharacters: ['{', '"', '@', ':', ' '], resolveProvider: false },
  hoverProvider: true,
  definitionProvider: true,
  documentSymbolProvider: true,
  documentFormattingProvider: true,
  codeActionProvider: { codeActionKinds: ['quickfix'] },
  renameProvider: { prepareProvider: true },
};

export class EzLanguageServer {
  readonly ws: Workspace;
  private initialized = false;
  private shutdown = false;
  private readonly out: Writable;
  private readonly log: (s: string) => void;

  constructor(private readonly o: ServerOptions = {}) {
    this.ws = new Workspace(resolve(o.root ?? process.cwd()));
    this.out = o.output ?? stdout;
    this.log = o.log ?? ((s) => process.stderr.write(`[eztest lsp] ${s}\n`));
    new MessageReader(o.input ?? stdin, (m) => {
      void this.handle(m);
    }, (e) => this.log(`bad message: ${e.message}`));
  }

  private send(m: Omit<Message, 'jsonrpc'>): void {
    writeMessage(this.out, { jsonrpc: '2.0', ...m });
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private publish(uri: string): void {
    const text = this.ws.text(uri);
    if (text === undefined || !formatOfUri(uri)) return;
    let diagnostics: Diagnostic[] = [];
    try {
      diagnostics = diagnose(this.ws, uri, text);
    } catch (e) {
      this.log(`diagnostics failed for ${uri}: ${(e as Error).message}`);
    }
    this.notify('textDocument/publishDiagnostics', { uri, diagnostics });
  }

  private republishAll(): void {
    for (const uri of this.ws.documents.keys()) this.publish(uri);
  }

  async handle(m: Message): Promise<void> {
    if (!m.method) return; // a response to a server request: none are sent
    const isRequest = m.id !== undefined && m.id !== null;
    try {
      const result = await this.dispatch(m.method, (m.params ?? {}) as TextDocumentParams & Record<string, unknown>);
      if (isRequest) this.send({ id: m.id, result: result === undefined ? null : result });
    } catch (e) {
      const err = e as Error & { code?: number };
      if (isRequest) this.send({ id: m.id, error: { code: typeof err.code === 'number' ? err.code : ErrorCodes.RequestFailed, message: err.message } });
      else this.log(`${m.method} failed: ${err.message}`);
    }
  }

  private doc(p: TextDocumentParams): { uri: string; text: string } {
    const uri = p.textDocument.uri;
    const text = this.ws.text(uri);
    if (text === undefined) throw Object.assign(new Error(`Unknown document ${uri}`), { code: ErrorCodes.InvalidParams });
    return { uri, text };
  }

  private async dispatch(method: string, p: TextDocumentParams & Record<string, unknown>): Promise<unknown> {
    if (!this.initialized && method !== 'initialize' && method !== 'exit') {
      throw Object.assign(new Error('Server not initialized'), { code: ErrorCodes.ServerNotInitialized });
    }
    switch (method) {
      case 'initialize': {
        const folders = p.workspaceFolders as Array<{ uri: string }> | null | undefined;
        const rootUri = (p.rootUri as string | null | undefined) ?? folders?.[0]?.uri;
        const root = rootUri ? uriToPath(rootUri) : (p.rootPath as string | undefined) ?? this.o.root;
        if (root) this.ws.root = resolve(root);
        this.ws.invalidate();
        this.initialized = true;
        return { capabilities: SERVER_CAPABILITIES, serverInfo: { name: 'eztest-lsp', version: '0.1.0' } };
      }
      case 'initialized':
        return undefined;
      case 'shutdown':
        this.shutdown = true;
        return null;
      case 'exit':
        (this.o.onExit ?? ((c: number) => process.exit(c)))(this.shutdown ? 0 : 1);
        return undefined;
      case '$/cancelRequest':
      case '$/setTrace':
        return undefined;
      case 'textDocument/didOpen':
        this.ws.documents.set(p.textDocument.uri, p.textDocument.text ?? '');
        this.ws.invalidate();
        this.publish(p.textDocument.uri);
        return undefined;
      case 'textDocument/didChange': {
        const last = p.contentChanges?.[p.contentChanges.length - 1];
        if (last) this.ws.documents.set(p.textDocument.uri, last.text);
        this.ws.invalidate();
        if (/eztest\.config\.(?:ya?ml|json)$/.test(p.textDocument.uri)) this.republishAll();
        else this.publish(p.textDocument.uri);
        return undefined;
      }
      case 'textDocument/didSave':
        this.ws.invalidate();
        this.republishAll();
        return undefined;
      case 'textDocument/didClose':
        this.ws.documents.delete(p.textDocument.uri);
        this.ws.invalidate();
        this.notify('textDocument/publishDiagnostics', { uri: p.textDocument.uri, diagnostics: [] });
        return undefined;
      case 'workspace/didChangeWatchedFiles':
      case 'workspace/didChangeConfiguration':
        this.ws.invalidate();
        this.republishAll();
        return undefined;
      case 'textDocument/completion': {
        const { uri, text } = this.doc(p);
        return { isIncomplete: false, items: complete(this.ws, uri, text, p.position!) };
      }
      case 'textDocument/hover': {
        const { uri, text } = this.doc(p);
        return hover(this.ws, uri, text, p.position!);
      }
      case 'textDocument/definition': {
        const { uri, text } = this.doc(p);
        return definition(this.ws, uri, text, p.position!);
      }
      case 'textDocument/documentSymbol': {
        const { uri, text } = this.doc(p);
        return documentSymbols(uri, text);
      }
      case 'textDocument/formatting': {
        const { uri, text } = this.doc(p);
        return format(uri, text);
      }
      case 'textDocument/codeAction': {
        const { uri, text } = this.doc(p);
        const ds = (p.context?.diagnostics ?? []).filter((d) => d.source === 'eztest');
        // Clients may drop `data`: recompute the matching diagnostics server side.
        const fresh = diagnose(this.ws, uri, text);
        const match = ds.map((d) => fresh.find((f) => f.range.start.line === d.range.start.line && f.code === d.code) ?? d);
        return codeActions(uri, text, match);
      }
      case 'textDocument/prepareRename': {
        const { uri, text } = this.doc(p);
        return prepareRename(this.ws, uri, text, p.position!);
      }
      case 'textDocument/rename': {
        const { uri, text } = this.doc(p);
        return rename(this.ws, uri, text, p.position!, String(p.newName ?? ''));
      }
      case 'eztest/journeys':
        return this.journeys();
      default:
        if (method.startsWith('$/')) return undefined;
        throw Object.assign(new Error(`Unhandled method ${method}`), { code: ErrorCodes.MethodNotFound });
    }
  }

  /** Workspace journeys with their top-level steps (for test explorers). */
  journeys(): Array<{ uri: string; id: string; name: string; line: number; library: boolean; steps: Array<{ line: number; text: string }> }> {
    return this.ws.journeys().map((j) => {
      const text = this.ws.text(j.uri) ?? '';
      const steps: Array<{ line: number; text: string }> = [];
      const ext = extname(uriToPath(j.uri)).toLowerCase();
      if (ext === '.ez') {
        for (const s of documentSymbols(j.uri, text)[0]?.children ?? []) if (s.kind === 12 || s.kind === 3) steps.push({ line: s.range.start.line, text: s.name });
      }
      return { uri: j.uri, id: j.id, name: j.name, line: j.nameLine, library: /^\s*tags\s*:.*@?library\b/im.test(text) || /^\s*tags:\s*\[.*\blibrary\b/m.test(text), steps };
    });
  }
}

/** Start the server on stdio (`eztest lsp`). Resolves when the client disconnects. */
export function startLanguageServer(o: ServerOptions = {}): Promise<void> {
  return new Promise((done) => {
    const input = o.input ?? stdin;
    new EzLanguageServer({ ...o, onExit: o.onExit ?? ((code) => process.exit(code)) });
    input.on('end', () => done());
    input.on('close', () => done());
  });
}

export { pathToUri, uriToPath };
