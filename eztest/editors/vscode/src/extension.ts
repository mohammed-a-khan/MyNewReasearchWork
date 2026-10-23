/**
 * EZTest for VS Code: a thin client over the `eztest` CLI.
 *
 * - Language features come from the `.ez` language server (`eztest lsp --stdio`).
 * - Journeys and their steps appear in the Test Explorer (VS Code Testing API);
 *   Run and Debug profiles call `eztest run` and map its output back to
 *   journeys and steps (with failure messages from the run's run.json).
 * - Commands: run / debug the current journey, validate, open EZTest Studio.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;
let studio: ChildProcess | undefined;
let output: vscode.OutputChannel;

interface JourneyInfo {
  uri: string;
  id: string;
  name: string;
  line: number;
  library: boolean;
  steps: Array<{ line: number; text: string }>;
}

/** Same as EZTest's default step id: a slug of the intent. */
export function stepId(intent: string): string {
  const slug = intent.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
  return slug.slice(0, 60).replace(/-+$/, '') || 'step';
}

function folderOf(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return (uri && vscode.workspace.getWorkspaceFolder(uri)) ?? vscode.workspace.workspaceFolders?.[0];
}

/** How to call the CLI: the eztest.cliPath setting, the workspace's node_modules/.bin/eztest, else npx. */
export function cliCommand(cwd: string): { command: string; args: string[]; shell: boolean } {
  const configured = vscode.workspace.getConfiguration('eztest').get<string>('cliPath')?.trim();
  const win = process.platform === 'win32';
  if (configured) return { command: configured, args: [], shell: win };
  for (let dir = cwd; ; dir = dirname(dir)) {
    const bin = join(dir, 'node_modules', '.bin', win ? 'eztest.cmd' : 'eztest');
    if (existsSync(bin)) return { command: bin, args: [], shell: win };
    if (dirname(dir) === dir) break;
  }
  return { command: win ? 'npx.cmd' : 'npx', args: ['--no-install', 'eztest'], shell: win };
}

// ------------------------------------------------------------------ language client

async function startClient(context: vscode.ExtensionContext): Promise<void> {
  const folder = folderOf();
  const cwd = folder?.uri.fsPath ?? process.cwd();
  const cli = cliCommand(cwd);
  const serverOptions: ServerOptions = {
    command: cli.command,
    args: [...cli.args, 'lsp'],
    transport: TransportKind.stdio,
    options: { cwd, shell: cli.shell },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'ez' },
      { scheme: 'file', pattern: '**/journeys/**/*.{yaml,yml,json}' },
    ],
    synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher('**/{*.ez,eztest.config.*,queries/**/*.sql}') },
    outputChannel: output,
  };
  client = new LanguageClient('eztest', 'EZTest language server', serverOptions, clientOptions);
  context.subscriptions.push(client);
  await client.start();
}

// ------------------------------------------------------------------ test explorer

const items = new WeakMap<vscode.TestItem, { journey: JourneyInfo; stepId?: string }>();

async function discover(controller: vscode.TestController): Promise<void> {
  if (!client) return;
  let journeys: JourneyInfo[] = [];
  try {
    journeys = await client.sendRequest<JourneyInfo[]>('eztest/journeys', {});
  } catch (e) {
    output.appendLine(`journey discovery failed: ${(e as Error).message}`);
    return;
  }
  const seen = new Set<string>();
  for (const j of journeys) {
    if (j.library) continue;
    const uri = vscode.Uri.parse(j.uri);
    const key = `${j.uri}#${j.id}`;
    seen.add(key);
    const item = controller.items.get(key) ?? controller.createTestItem(key, j.name, uri);
    item.label = j.name;
    item.range = new vscode.Range(j.line, 0, j.line, 0);
    item.description = j.id;
    items.set(item, { journey: j });
    const kids: vscode.TestItem[] = [];
    const ids = new Map<string, number>();
    for (const s of j.steps) {
      const base = stepId(s.text);
      const n = (ids.get(base) ?? 0) + 1;
      ids.set(base, n);
      const sid = n > 1 ? `${base}-${n}` : base;
      const child = controller.createTestItem(`${key}/${sid}`, s.text, uri);
      child.range = new vscode.Range(s.line, 0, s.line, 0);
      items.set(child, { journey: j, stepId: sid });
      kids.push(child);
    }
    item.children.replace(kids);
    controller.items.add(item);
  }
  controller.items.forEach((i) => {
    if (!seen.has(i.id)) controller.items.delete(i.id);
  });
}

interface StepResultJson { stepId: string; status: string; error?: { message?: string }; children?: StepResultJson[] }
interface RunJson { journeys: Array<{ journeyId: string; name?: string; status: string; error?: { message?: string }; steps: StepResultJson[] }> }

function flatten(steps: StepResultJson[]): StepResultJson[] {
  return steps.flatMap((s) => [s, ...flatten(s.children ?? [])]);
}

async function runHandler(controller: vscode.TestController, debug: boolean, request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
  const run = controller.createTestRun(request);
  const wanted: vscode.TestItem[] = [];
  if (request.include?.length) {
    for (const i of request.include) wanted.push(i.parent ?? i);
  } else controller.items.forEach((i) => wanted.push(i));
  const journeys = [...new Set(wanted)].filter((i) => !request.exclude?.includes(i));
  // One CLI run per file, journeys of other files are untouched.
  const byFile = new Map<string, vscode.TestItem[]>();
  for (const j of journeys) {
    const file = j.uri!.fsPath;
    byFile.set(file, [...(byFile.get(file) ?? []), j]);
  }
  for (const [file, list] of byFile) {
    if (token.isCancellationRequested) break;
    for (const j of list) {
      run.started(j);
      j.children.forEach((c) => run.enqueued(c));
    }
    const folder = folderOf(vscode.Uri.file(file));
    const cwd = folder?.uri.fsPath ?? dirname(file);
    const cli = cliCommand(cwd);
    const extra = vscode.workspace.getConfiguration('eztest').get<string[]>('runArgs') ?? [];
    const args = [...cli.args, 'run', file, '--reporter', 'json', ...(debug ? ['--headed', '--trace'] : []), ...extra];
    run.appendOutput(`$ eztest ${args.slice(cli.args.length).join(' ')}\r\n`);
    const started = Date.now();
    const lines: string[] = [];
    const code = await new Promise<number>((done) => {
      const p = spawn(cli.command, args, { cwd, shell: cli.shell, env: process.env });
      token.onCancellationRequested(() => p.kill());
      let buf = '';
      const onData = (d: Buffer) => {
        buf += String(d);
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? '';
        for (const l of parts) {
          lines.push(l);
          run.appendOutput(l + '\r\n');
        }
      };
      p.stdout.on('data', onData);
      p.stderr.on('data', onData);
      p.on('close', (c) => {
        if (buf) lines.push(buf);
        done(c ?? 1);
      });
      p.on('error', (e) => {
        run.appendOutput(`${e.message}\r\n`);
        done(1);
      });
    });
    // Details from run.json (next to the JSON report), else from the console output.
    const report = lines.map((l) => /^report json: (.+)$/.exec(l.trim())?.[1]).find(Boolean);
    let detail: RunJson | undefined;
    if (report) {
      try {
        detail = JSON.parse(readFileSync(join(dirname(resolve(cwd, report)), 'run.json'), 'utf8')) as RunJson;
      } catch {
        detail = undefined;
      }
    }
    for (const j of list) {
      const info = items.get(j)!;
      const results = detail?.journeys.filter((r) => r.journeyId === info.journey.id || r.journeyId.startsWith(`${info.journey.id}-`)) ?? [];
      const consoleStatus = consoleResult(lines, info.journey.name);
      const failed = results.length ? results.some((r) => r.status === 'failed' || r.status === 'error') : consoleStatus === 'failed' || consoleStatus === 'error' || (consoleStatus === undefined && code !== 0);
      const steps = results.flatMap((r) => flatten(r.steps));
      j.children.forEach((c) => {
        const sid = items.get(c)?.stepId;
        const mine = steps.filter((s) => s.stepId === sid);
        if (!mine.length) return run.skipped(c);
        const bad = mine.find((s) => s.status === 'failed' || s.status === 'error');
        if (bad) run.failed(c, locatedMessage(bad.error?.message ?? 'failed', c));
        else if (mine.every((s) => s.status === 'skipped' || s.status === 'blocked')) run.skipped(c);
        else run.passed(c);
      });
      const ms = Date.now() - started;
      if (failed) {
        const first = results.flatMap((r) => flatten(r.steps)).find((s) => s.status === 'failed' || s.status === 'error');
        run.failed(j, locatedMessage(first?.error?.message ?? results.find((r) => r.error)?.error?.message ?? `eztest run exited with ${code}`, j), ms);
      } else run.passed(j, ms);
    }
  }
  run.end();
}

/** The status a journey reached in the console output ("> name" ... "=> status"). */
function consoleResult(lines: string[], name: string): string | undefined {
  let current: string | undefined;
  let status: string | undefined;
  for (const l of lines) {
    const start = /^> (.+)$/.exec(l);
    if (start) current = start[1];
    const end = /^\s+=> (\w[\w-]*)/.exec(l);
    if (end && current && (current === name || current.startsWith(`${name} [`))) status = status === 'failed' ? status : end[1];
  }
  return status;
}

function locatedMessage(text: string, item: vscode.TestItem): vscode.TestMessage {
  const m = new vscode.TestMessage(text);
  if (item.uri && item.range) m.location = new vscode.Location(item.uri, item.range);
  return m;
}

// ------------------------------------------------------------------ commands

function currentEzFile(arg?: vscode.Uri): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const doc = vscode.window.activeTextEditor?.document;
  return doc && (doc.languageId === 'ez' || /\.(ez|ya?ml|json)$/.test(doc.fileName)) ? doc.uri : undefined;
}

async function runFile(controller: vscode.TestController, profile: vscode.TestRunProfile, uri: vscode.Uri | undefined): Promise<void> {
  if (!uri) return void vscode.window.showWarningMessage('Open a journey (.ez) to run it.');
  await discover(controller);
  const include: vscode.TestItem[] = [];
  controller.items.forEach((i) => {
    if (i.uri?.fsPath === uri.fsPath) include.push(i);
  });
  if (!include.length) return void vscode.window.showWarningMessage('No runnable journey in this file (library journeys run from their callers).');
  const cts = new vscode.CancellationTokenSource();
  await profile.runHandler(new vscode.TestRunRequest(include, undefined, profile), cts.token);
}

function openStudio(context: vscode.ExtensionContext): void {
  const folder = folderOf(vscode.window.activeTextEditor?.document.uri);
  const cwd = folder?.uri.fsPath ?? process.cwd();
  if (studio && studio.exitCode === null) {
    void vscode.window.showInformationMessage('EZTest Studio is already running (see the EZTest output).');
    return;
  }
  const cli = cliCommand(cwd);
  output.show(true);
  studio = spawn(cli.command, [...cli.args, 'studio', '--no-open'], { cwd, shell: cli.shell, env: process.env });
  const onData = (d: Buffer) => {
    const text = String(d);
    output.append(text);
    const url = /EZTest Studio: (\S+)/.exec(text)?.[1];
    if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
  };
  studio.stdout?.on('data', onData);
  studio.stderr?.on('data', onData);
  context.subscriptions.push({ dispose: () => studio?.kill() });
}

function validate(): void {
  const folder = folderOf(vscode.window.activeTextEditor?.document.uri);
  const cwd = folder?.uri.fsPath ?? process.cwd();
  const cli = cliCommand(cwd);
  const term = vscode.window.createTerminal({ name: 'EZTest', cwd });
  term.show();
  term.sendText([cli.command, ...cli.args, 'validate'].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '));
}

// ------------------------------------------------------------------ activation

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('EZTest');
  context.subscriptions.push(output);
  try {
    await startClient(context);
  } catch (e) {
    output.appendLine(`Could not start the .ez language server: ${(e as Error).message}. Install eztest in the workspace or set eztest.cliPath.`);
  }

  const controller = vscode.tests.createTestController('eztest', 'EZTest journeys');
  context.subscriptions.push(controller);
  controller.refreshHandler = () => discover(controller);
  const runProfile = controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (r, t) => runHandler(controller, false, r, t), true);
  const debugProfile = controller.createRunProfile('Debug (headed, trace)', vscode.TestRunProfileKind.Debug, (r, t) => runHandler(controller, true, r, t), true);
  await discover(controller);
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ez,yaml,yml,json}');
  const refresh = () => void discover(controller);
  watcher.onDidCreate(refresh);
  watcher.onDidDelete(refresh);
  watcher.onDidChange(refresh);
  context.subscriptions.push(watcher, vscode.workspace.onDidSaveTextDocument(refresh));

  context.subscriptions.push(
    vscode.commands.registerCommand('eztest.runJourney', (uri?: vscode.Uri) => runFile(controller, runProfile, currentEzFile(uri))),
    vscode.commands.registerCommand('eztest.debugJourney', (uri?: vscode.Uri) => runFile(controller, debugProfile, currentEzFile(uri))),
    vscode.commands.registerCommand('eztest.validate', () => validate()),
    vscode.commands.registerCommand('eztest.openStudio', () => openStudio(context)),
    vscode.commands.registerCommand('eztest.restartServer', async () => {
      await client?.restart();
      await discover(controller);
    }),
  );
}

export async function deactivate(): Promise<void> {
  studio?.kill();
  await client?.stop();
}
