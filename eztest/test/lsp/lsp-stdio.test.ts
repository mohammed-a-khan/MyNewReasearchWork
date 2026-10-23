/**
 * The `.ez` language server, driven over stdio exactly as an editor would:
 * `eztest lsp --stdio` is spawned and spoken to with framed JSON-RPC.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MessageReader, writeMessage, type Message } from '../../src/lsp/index.js';

const ROOT = resolve(__dirname, '../..');
const FIXTURE = resolve(__dirname, 'fixtures/project');

class Client {
  private seq = 0;
  private pending = new Map<number, (m: Message) => void>();
  readonly notifications: Message[] = [];
  private waiters: Array<{ pred: (m: Message) => boolean; done: (m: Message) => void }> = [];
  exited: Promise<number>;

  constructor(readonly proc: ChildProcessWithoutNullStreams) {
    new MessageReader(proc.stdout, (m) => {
      if (m.id !== undefined && m.id !== null && !m.method) {
        this.pending.get(Number(m.id))?.(m);
        this.pending.delete(Number(m.id));
        return;
      }
      this.notifications.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.done(m), false) : true));
    });
    this.exited = new Promise((r) => proc.on('exit', (code) => r(code ?? -1)));
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = ++this.seq;
    return new Promise((resolveP, reject) => {
      this.pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolveP(m.result as T)));
      writeMessage(this.proc.stdin, { jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    writeMessage(this.proc.stdin, { jsonrpc: '2.0', method, params });
  }

  next(pred: (m: Message) => boolean, timeoutMs = 20_000): Promise<Message> {
    const hit = this.notifications.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((done, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for a notification')), timeoutMs);
      this.waiters.push({ pred, done: (m) => (clearTimeout(t), done(m)) });
    });
  }
}

interface Diag { range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity: number; code: string; message: string; data?: { suggestions: string[] } }

let dir: string;
let client: Client;
const uri = (rel: string) => pathToFileURL(join(dir, rel)).href;

async function open(rel: string, text?: string): Promise<string> {
  const u = uri(rel);
  const body = text ?? (await readFile(join(dir, rel), 'utf8'));
  client.notifications.length = 0;
  client.notify('textDocument/didOpen', { textDocument: { uri: u, languageId: 'ez', version: 1, text: body } });
  return u;
}

async function diagnostics(u: string): Promise<Diag[]> {
  const m = await client.next((x) => x.method === 'textDocument/publishDiagnostics' && (x.params as { uri: string }).uri === u);
  return (m.params as { diagnostics: Diag[] }).diagnostics;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eztest-lsp-'));
  await cp(FIXTURE, dir, { recursive: true });
  const proc = spawn(process.execPath, ['--import', pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, join(ROOT, 'src/cli/bin.ts'), 'lsp', '--stdio'], { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  client = new Client(proc);
  const init = await client.request<{ capabilities: Record<string, unknown>; serverInfo: { name: string } }>('initialize', { processId: process.pid, rootUri: pathToFileURL(dir).href, capabilities: {} });
  expect(init.serverInfo.name).toBe('eztest-lsp');
  expect(init.capabilities).toMatchObject({ hoverProvider: true, definitionProvider: true, documentSymbolProvider: true, documentFormattingProvider: true, renameProvider: { prepareProvider: true }, codeActionProvider: { codeActionKinds: ['quickfix'] } });
  client.notify('initialized', {});
}, 60_000);

afterAll(async () => {
  if (!client) return;
  await client.request('shutdown', null);
  client.notify('exit', null);
  expect(await client.exited).toBe(0);
});

describe('eztest lsp over stdio', () => {
  it('publishes no diagnostics for a valid journey', async () => {
    const u = await open('journeys/create-order.ez');
    expect(await diagnostics(u)).toEqual([]);
  });

  it('reports an unknown phrasing with the closest phrasing and offers it as a quick fix', async () => {
    const text = 'Journey: Typo\n\nOpen /login\nClik the "Sign in" button\n';
    const u = await open('journeys/typo.ez', text);
    const ds = await diagnostics(u);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ severity: 1, code: 'eztest.parse', range: { start: { line: 3 } } });
    expect(ds[0].message).toMatch(/Closest phrasing: Click/);
    const actions = await client.request<Array<{ title: string; kind: string; isPreferred?: boolean; edit: { changes: Record<string, Array<{ range: Diag['range']; newText: string }>> } }>>('textDocument/codeAction', {
      textDocument: { uri: u }, range: ds[0].range, context: { diagnostics: [{ ...ds[0], data: undefined }] },
    });
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]).toMatchObject({ kind: 'quickfix', isPreferred: true });
    expect(actions[0].title).toMatch(/^Use "Click/);
    const edit = actions[0].edit.changes[u][0];
    expect(edit.range.start).toEqual({ line: 3, character: 0 });
    expect(edit.newText).toMatch(/^Click/);
  });

  it('warns about unknown roles, journeys and named queries, with did-you-mean fixes', async () => {
    const text = 'Journey: Refs\n\nLog in as manger\nRun journey "open-the-order-page"\nRun query "OPEN_ORDER" on shop and store the rows as r\n';
    const u = await open('journeys/refs.ez', text);
    const ds = await diagnostics(u);
    expect(ds.map((d) => [d.code, d.range.start.line, d.data?.suggestions[0]])).toEqual([
      ['eztest.unknown-role', 2, 'manager'],
      ['eztest.unknown-journey', 3, 'open-the-orders-page'],
      ['eztest.unknown-query', 4, 'OPEN_ORDERS'],
    ]);
    expect(ds.every((d) => d.severity === 2)).toBe(true);
    const actions = await client.request<Array<{ edit: { changes: Record<string, Array<{ range: Diag['range']; newText: string }>> } }>>('textDocument/codeAction', { textDocument: { uri: u }, range: ds[0].range, context: { diagnostics: [ds[0]] } });
    expect(actions[0].edit.changes[u][0]).toEqual({ range: { start: { line: 2, character: 10 }, end: { line: 2, character: 16 } }, newText: 'manager' });
  });

  it('completes phrasings, roles, journeys, named queries and variables', async () => {
    const text = 'Journey: Complete\nVariables: qty=2\n\nLog in as \nRun journey "\nRun query "\nType "${q\nCli\n';
    const u = await open('journeys/complete.ez', text);
    type Items = { items: Array<{ label: string; insertTextFormat?: number; textEdit?: { newText: string } }> };
    const at = (line: number, character: number) => client.request<Items>('textDocument/completion', { textDocument: { uri: u }, position: { line, character } });
    expect((await at(3, 10)).items.map((i) => i.label)).toEqual(['manager', 'sales-rep']);
    expect((await at(4, 13)).items.map((i) => i.label)).toEqual(expect.arrayContaining(['open-the-orders-page', 'manager-creates-an-order']));
    expect((await at(5, 11)).items.map((i) => i.label)).toEqual(['OPEN_ORDERS']);
    const vars = (await at(6, 9)).items;
    expect(vars.map((i) => i.label)).toContain('qty');
    expect(vars.find((i) => i.label === 'qty')!.textEdit!.newText).toBe('qty}');
    const phrases = (await at(7, 3)).items;
    const click = phrases.find((i) => i.label.startsWith('Click the "'));
    expect(click?.insertTextFormat).toBe(2);
    expect(click?.textEdit?.newText).toMatch(/^Click the "\$\{1:[^}]+\}"/);
  });

  it('explains a line on hover', async () => {
    const u = await open('journeys/create-order.ez');
    const h = await client.request<{ contents: { value: string } }>('textDocument/hover', { textDocument: { uri: u }, position: { line: 8, character: 3 } });
    expect(h.contents.value).toMatch(/Action: `click`/);
    expect(h.contents.value).toMatch(/Target: `the "Submit order" button`/);
    expect(h.contents.value).toMatch(/Checks: .*created/);
    const q = await client.request<{ contents: { value: string } }>('textDocument/hover', { textDocument: { uri: u }, position: { line: 13, character: 13 } });
    expect(q.contents.value).toContain('SELECT id, total FROM orders');
    const r = await client.request<{ contents: { value: string } }>('textDocument/hover', { textDocument: { uri: u }, position: { line: 2, character: 8 } });
    expect(r.contents.value).toMatch(/\*\*Role\*\* manager: login \/login/);
  });

  it('goes to the definition of a sub-journey, a named query, a role and a variable', async () => {
    const u = await open('journeys/create-order.ez');
    type Loc = Array<{ uri: string; range: Diag['range'] }>;
    const def = (line: number, character: number) => client.request<Loc>('textDocument/definition', { textDocument: { uri: u }, position: { line, character } });
    expect(await def(5, 16)).toEqual([{ uri: uri('journeys/open-orders.ez'), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }]);
    expect((await def(13, 13))[0].uri).toBe(uri('queries/OPEN_ORDERS.sql'));
    const role = await def(2, 8);
    expect(role[0].uri).toBe(uri('eztest.config.yaml'));
    expect(role[0].range.start).toEqual({ line: 5, character: 4 });
    expect(await def(7, 32)).toEqual([{ uri: u, range: { start: { line: 3, character: 11 }, end: { line: 3, character: 14 } } }]);
    // A bare variable inside an expression.
    expect(await def(11, 26)).toEqual([{ uri: u, range: { start: { line: 10, character: 42 }, end: { line: 10, character: 47 } } }]);
  });

  it('lists document symbols with steps, their expectations and blocks', async () => {
    const text = 'Journey: Symbols\nTags: @x\n\nOpen /\n  Expect the page contains "Hi"\nIf the "More" button is visible then\n  Click the "More" button\nOtherwise\n  Reload the page\nEnd\nPress Tab\n';
    const u = await open('journeys/symbols.ez', text);
    type Sym = { name: string; kind: number; range: Diag['range']; children: Sym[] };
    const [root] = await client.request<Sym[]>('textDocument/documentSymbol', { textDocument: { uri: u } });
    expect(root.name).toBe('Symbols');
    expect(root.children.map((c) => c.name)).toEqual(['Journey: Symbols', 'Tags: @x', 'Open /', 'If the "More" button is visible then', 'Press Tab']);
    expect(root.children[2].children.map((c) => c.name)).toEqual(['Expect the page contains "Hi"']);
    const block = root.children[3];
    expect(block.children.map((c) => c.name)).toEqual(['Click the "More" button', 'Otherwise', 'Reload the page']);
    expect(block.range.end.line).toBe(9);
  });

  it('formats a document', async () => {
    const text = 'journey:   Messy\n\n\n\nOpen /\nExpect the page contains "x"\n';
    const u = await open('journeys/messy.ez', text);
    const edits = await client.request<Array<{ newText: string }>>('textDocument/formatting', { textDocument: { uri: u }, options: { tabSize: 2, insertSpaces: true } });
    expect(edits).toHaveLength(1);
    expect(edits[0].newText).toBe('Journey: Messy\n\nOpen /\n  Expect the page contains "x"\n');
  });

  it('renames a variable everywhere it is defined and used (including bare names in expressions)', async () => {
    const u = await open('journeys/create-order.ez');
    const prep = await client.request<{ placeholder: string }>('textDocument/prepareRename', { textDocument: { uri: u }, position: { line: 10, character: 44 } });
    expect(prep.placeholder).toBe('total');
    const edit = await client.request<{ changes: Record<string, Array<{ range: Diag['range']; newText: string }>> }>('textDocument/rename', { textDocument: { uri: u }, position: { line: 10, character: 44 }, newName: 'orderTotal' });
    expect(edit.changes[u].map((e) => [e.range.start.line, e.range.start.character, e.newText])).toEqual([
      [10, 42, 'orderTotal'],
      [11, 24, 'orderTotal'],
    ]);
  });

  it('renames a journey in its header and in every "Run journey" reference across files', async () => {
    const lib = await open('journeys/open-orders.ez');
    const edit = await client.request<{ changes: Record<string, Array<{ range: Diag['range']; newText: string }>> }>('textDocument/rename', { textDocument: { uri: lib }, position: { line: 0, character: 12 }, newName: 'Open the order list' });
    expect(edit.changes[lib]).toEqual([{ range: { start: { line: 0, character: 9 }, end: { line: 0, character: 29 } }, newText: 'Open the order list' }]);
    // The caller refers to the derived id, which follows the new name.
    expect(edit.changes[uri('journeys/create-order.ez')]).toEqual([{ range: { start: { line: 5, character: 13 }, end: { line: 5, character: 33 } }, newText: 'open-the-order-list' }]);
  });

  it('lists journeys and their steps for test explorers (eztest/journeys)', async () => {
    const js = await client.request<Array<{ id: string; library: boolean; steps: Array<{ line: number; text: string }> }>>('eztest/journeys', {});
    const co = js.find((j) => j.id === 'manager-creates-an-order')!;
    expect(co.library).toBe(false);
    expect(co.steps[0]).toEqual({ line: 5, text: 'Run journey "open-the-orders-page" with role=manager' });
    expect(js.find((j) => j.id === 'open-the-orders-page')!.library).toBe(true);
  });

  it('answers unknown methods with MethodNotFound', async () => {
    await expect(client.request('textDocument/nonsense', {})).rejects.toThrow(/Unhandled method/);
  });
});
