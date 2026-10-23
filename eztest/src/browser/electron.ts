/**
 * Electron apps over CDP: `electron.launch()` starts the app with a DevTools
 * port (renderer windows, driven like browser pages) and a Node inspector
 * port (main process, for `app.evaluate()`), both on 127.0.0.1 with port 0.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { TypedEmitter } from './events.js';
import { TimeoutError } from './errors.js';
import { CDPConnection, type CDPSession } from './transport/connection.js';
import { WebSocketTransport } from './transport/transport.js';
import { CrBrowser, type ChromiumBrowserType, type CrBrowserContext } from './chromium/browser.js';
import type { CrPage } from './chromium/page.js';
import { KEEP_NAMES_SHIM, deserializeValue, functionSource, pageCodec, serializeArgument } from './serializer.js';
import { settleWithin, withTimeout } from './util.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ElectronLaunchOptions {
  executablePath?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
  /** Context options applied to the app's windows (viewport is not overridden by default). */
  recordVideo?: { dir: string };
}

export interface ElectronEvents {
  close: ElectronApplication;
  window: CrPage;
  console: unknown;
}

const CODEC = `(${pageCodec.toString()})()`;

export class ElectronApplication extends TypedEmitter<ElectronEvents> {
  constructor(
    private readonly proc: ChildProcess,
    private readonly browser: CrBrowser,
    private readonly node: CDPSession,
    private readonly nodeConnection: CDPConnection,
  ) {
    super();
    browser.defaultContext().on('page', (p) => this.emitEvent('window', p));
    proc.once('exit', () => this.emitEvent('close', this));
  }

  context(): CrBrowserContext {
    return this.browser.defaultContext();
  }

  windows(): CrPage[] {
    return this.context().pages();
  }

  async firstWindow(options: { timeout?: number } = {}): Promise<CrPage> {
    const existing = this.windows()[0];
    if (existing) return existing;
    return this.waitForEvent('window', { timeout: options.timeout ?? 30_000 });
  }

  process(): ChildProcess {
    return this.proc;
  }

  /** Evaluate in the main process: fn(electronModule, arg). */
  async evaluate<R, Arg = unknown>(fn: (electron: any, arg: Arg) => R | Promise<R>, arg?: Arg): Promise<R> {
    const encoded = serializeArgument(arg, () => false, []);
    const expression = `(async () => { ${KEEP_NAMES_SHIM}
      const codec = ${CODEC};
      const req = (globalThis.process && process.mainModule && process.mainModule.require) ? process.mainModule.require.bind(process.mainModule) : globalThis.require;
      const electron = globalThis.__ezElectron || (req ? req('electron') : undefined);
      if (electron && electron.app && !electron.app.isReady()) await electron.app.whenReady();
      const r = await (${functionSource(fn)})(electron, codec.deser(${JSON.stringify(encoded)}, []));
      return codec.ser(r);
    })()`;
    const res = await this.node.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return deserializeValue(res.result.value) as R;
  }

  async close(): Promise<void> {
    const exited = new Promise<void>((r) => {
      if (this.proc.exitCode !== null) r();
      else this.proc.once('exit', () => r());
    });
    await this.evaluate((e: any) => e.app.quit()).catch(() => undefined);
    await settleWithin(exited, 5000, undefined);
    if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
    this.nodeConnection.close();
    await this.browser.close().catch(() => undefined);
  }
}

function electronBinary(): string {
  try {
    const req = createRequire(`${process.cwd()}/`);
    const p = req('electron') as unknown;
    if (typeof p === 'string') return p;
  } catch {
    /* not installed */
  }
  throw new Error('Electron not found: pass executablePath, or install the "electron" package in the project');
}

export class ElectronLauncher {
  constructor(private readonly type: ChromiumBrowserType) {}

  async launch(options: ElectronLaunchOptions = {}): Promise<ElectronApplication> {
    const exe = options.executablePath ?? electronBinary();
    const args = ['--inspect=0', '--remote-debugging-port=0', ...(options.args ?? [])];
    const proc = spawn(exe, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const timeout = options.timeout ?? 30_000;
    const endpoints = await withTimeout(new Promise<{ devtools: string; node: string }>((resolve, reject) => {
      let devtools: string | undefined;
      let node: string | undefined;
      let buf = '';
      const onData = (d: Buffer) => {
        buf += d.toString('utf8');
        devtools ??= /DevTools listening on (ws:\/\/\S+)/.exec(buf)?.[1];
        node ??= /Debugger listening on (ws:\/\/\S+)/.exec(buf)?.[1];
        if (devtools && node) resolve({ devtools, node });
      };
      proc.stderr?.on('data', onData);
      proc.stdout?.on('data', onData);
      proc.once('exit', (code) => reject(new Error(`Electron exited with code ${code} before it was ready:\n${buf.slice(-2000)}`)));
      proc.once('error', reject);
    }), timeout, () => `electron.launch: Timeout ${timeout}ms exceeded waiting for the DevTools endpoints`).catch((e) => {
      proc.kill('SIGKILL');
      throw e instanceof TimeoutError ? e : e;
    });
    const nodeTransport = await WebSocketTransport.connect(endpoints.node, timeout);
    const nodeConnection = new CDPConnection(nodeTransport);
    await nodeConnection.root.send('Runtime.enable').catch(() => undefined);
    await nodeConnection.root.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
    const transport = await WebSocketTransport.connect(endpoints.devtools, timeout);
    const browser = await CrBrowser.create(new CDPConnection(transport), undefined, 0, this.type);
    const ctx = browser.defaultContext();
    if (options.recordVideo) Object.assign(ctx.options, { recordVideo: options.recordVideo });
    return new ElectronApplication(proc, browser, nodeConnection.root, nodeConnection);
  }
}
