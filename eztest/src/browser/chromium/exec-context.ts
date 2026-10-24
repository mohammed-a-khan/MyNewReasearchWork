/**
 * A JavaScript execution context (one world of one frame, or a worker) and
 * evaluation through Runtime.callFunctionOn with the tagged-JSON codec.
 */
import { ENGINE_GLOBAL } from '../injected/contract.js';
import { driverHelpersSource } from '../injected/driver-helpers.js';
import { engineSource } from '../injected/index.js';
import { isContextGoneError } from '../errors.js';
import { CONTEXT_GONE_TEXT, DISPOSED_HANDLE_TEXT, FOREIGN_HANDLE_TEXT } from '../messages.js';
import { KEEP_NAMES_SHIM, deserializeValue, functionSource, pageCodec, serializeArgument } from '../serializer.js';
import type { CDPSession, ProtocolResult } from '../transport/connection.js';
import type { ChromiumFrame } from './frame.js';
import { ElementHandle, JSHandle } from './handles.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type World = 'main' | 'engine' | 'worker';

const HELPERS_GLOBAL = '__eztestDriver';
const CODEC = `(${pageCodec.toString()})()`;

export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
  preview?: unknown;
}

export class ExecutionContext {
  disposed = false;
  private installing?: Promise<void>;

  constructor(
    readonly session: CDPSession,
    readonly id: number,
    readonly frame: ChromiumFrame | undefined,
    readonly world: World,
    /** Owning worker, for worker contexts. */
    readonly worker?: unknown,
  ) {}

  /** Wrap a remote object into a handle of this context. */
  createHandle(obj: RemoteObject): JSHandle {
    if (obj.subtype === 'node' && this.frame) return new ElementHandle(this, obj);
    return new JSHandle(this, obj);
  }

  /** Source of the wrapper that decodes arguments, calls the user function and encodes the result. */
  private wrapper(fnSrc: string, returnByValue: boolean, isExpression: boolean): string {
    const call = isExpression
      ? `let r = (${fnSrc}); if (typeof r === 'function') r = r(...args);`
      : `const fn = (${fnSrc}); let r = fn(...args);`;
    return `async function (__ezArgs, ...__ezHandles) {
      ${KEEP_NAMES_SHIM}
      const __ezCodec = ${CODEC};
      const args = __ezCodec.deser(__ezArgs, __ezHandles);
      ${call}
      r = await r;
      return ${returnByValue ? '__ezCodec.ser(r)' : 'r'};
    }`;
  }

  /**
   * Evaluate a function (or an expression string) with arguments. With
   * `returnByValue` the result is decoded to a Node value, otherwise a handle.
   */
  async evaluate(fn: ((...a: any[]) => unknown) | string, args: unknown[], returnByValue: boolean): Promise<unknown> {
    const handles: JSHandle[] = [];
    const encoded = serializeArgument(args, (v) => v instanceof JSHandle, handles as unknown[]);
    const handleArgs = await Promise.all(handles.map((h) => this.adoptArgument(h)));
    let fnSrc: string;
    let isExpression = false;
    if (typeof fn === 'string') {
      fnSrc = fn;
      isExpression = true;
      // A string that is itself a function source is called like a function.
      if (/^\s*(async\s+)?(function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(fn)) isExpression = true;
    } else {
      fnSrc = functionSource(fn);
    }
    const run = async (src: string, expr: boolean) => {
      const res = await this.session.send('Runtime.callFunctionOn', {
        functionDeclaration: this.wrapper(src, returnByValue, expr),
        executionContextId: this.id,
        arguments: [{ value: encoded }, ...handleArgs.map((h) => ({ objectId: h }))],
        returnByValue,
        awaitPromise: true,
        userGesture: true,
      });
      return res;
    };
    let res: ProtocolResult;
    try {
      res = await run(fnSrc, isExpression);
    } catch (e) {
      // An expression with statements (e.g. "a; b") cannot be wrapped in parentheses: evaluate it directly.
      if (isExpression && /SyntaxError|Unexpected token|missing \)/.test((e as Error).message)) return this.evaluateStatements(fnSrc, returnByValue);
      throw this.rewrite(e as Error);
    }
    if (res.exceptionDetails) {
      const err = this.exceptionToError(res.exceptionDetails);
      // A string with statements ("a; b") cannot be wrapped as an expression: run it as a script.
      if (isExpression && err.name === 'SyntaxError' && !res.exceptionDetails.stackTrace) return this.evaluateStatements(fnSrc, returnByValue);
      throw err;
    }
    if (returnByValue) return deserializeValue((res.result as RemoteObject).value);
    return this.createHandle(res.result as RemoteObject);
  }

  private async evaluateStatements(expression: string, returnByValue: boolean): Promise<unknown> {
    const res = await this.session.send('Runtime.evaluate', { expression, contextId: this.id, awaitPromise: true, returnByValue: false, userGesture: true });
    if (res.exceptionDetails) throw this.exceptionToError(res.exceptionDetails);
    const h = this.createHandle(res.result as RemoteObject);
    if (!returnByValue) return h;
    try {
      return await h.jsonValue();
    } finally {
      await h.dispose();
    }
  }

  /** objectId usable in this context for a handle (adopting element handles from other worlds). */
  private async adoptArgument(h: JSHandle): Promise<string> {
    if (h.disposed) throw new Error(DISPOSED_HANDLE_TEXT);
    if (h.context === this) return h.objectId!;
    if (!(h instanceof ElementHandle)) throw new Error(FOREIGN_HANDLE_TEXT);
    const adopted = await this.adoptElement(h);
    return adopted.objectId!;
  }

  /** Move an element handle into this context (same frame, other world). */
  async adoptElement(h: ElementHandle): Promise<ElementHandle> {
    if (h.context === this) return h;
    const { node } = await h.context.session.send('DOM.describeNode', { objectId: h.objectId });
    const { object } = await this.session.send('DOM.resolveNode', { backendNodeId: node.backendNodeId, executionContextId: this.id });
    return this.createHandle(object as RemoteObject) as ElementHandle;
  }

  /** Own enumerable properties of a handle's object, as handles of this context. */
  async getProperties(h: JSHandle): Promise<Map<string, JSHandle>> {
    const out = new Map<string, JSHandle>();
    if (!h.objectId) return out;
    const { result } = await this.session.send('Runtime.getProperties', { objectId: h.objectId, ownProperties: true });
    for (const p of result as Array<{ name: string; enumerable: boolean; value?: RemoteObject }>) {
      if (!p.enumerable || !p.value) continue;
      out.set(p.name, this.createHandle(p.value));
    }
    return out;
  }

  /** Let the browser free the object behind a handle. */
  async releaseHandle(h: JSHandle): Promise<void> {
    if (h.objectId) await this.session.send('Runtime.releaseObject', { objectId: h.objectId }).catch(() => undefined);
  }

  /** The frame an <iframe>/<frame> element handle shows, or null. */
  async contentFrameOf(h: ElementHandle): Promise<ChromiumFrame | null> {
    const { node } = await this.session.send('DOM.describeNode', { objectId: h.objectId });
    const frameId = (node.frameId as string | undefined) ?? (node.contentDocument?.frameId as string | undefined);
    if (!frameId || !/^(iframe|frame)$/i.test(String(node.nodeName))) return null;
    const page = h.frame._page;
    return page.frameById(frameId) ?? (await page.waitForFrameById(frameId, 2000));
  }

  /** Set the files of an <input type=file> from paths on this machine. */
  async setInputFilePaths(h: ElementHandle, paths: string[]): Promise<void> {
    await this.session.send('DOM.setFileInputFiles', { files: paths, objectId: h.objectId });
  }

  /** Make sure the selector engine and driver helpers exist in this (engine-world) context. */
  ensureEngine(): Promise<void> {
    if (!this.installing) {
      this.installing = (async () => {
        const expression = `(() => { ${KEEP_NAMES_SHIM}
          if (!globalThis['${ENGINE_GLOBAL}']) globalThis['${ENGINE_GLOBAL}'] = ${engineSource()};
          if (!globalThis['${HELPERS_GLOBAL}']) globalThis['${HELPERS_GLOBAL}'] = ${driverHelpersSource()};
          return true; })()`;
        const res = await this.session.send('Runtime.evaluate', { expression, contextId: this.id, returnByValue: true });
        if (res.exceptionDetails) throw this.exceptionToError(res.exceptionDetails);
      })();
      this.installing.catch(() => {
        this.installing = undefined;
      });
    }
    return this.installing;
  }

  /**
   * The elements a selector chain matches now (under `scope`, else the document), in document
   * order, as handles of this context. Engines that can return nodes by reference in the same
   * call (WebDriver BiDi) override this with a single round trip.
   */
  async queryElements(chain: unknown, scope?: ElementHandle): Promise<ElementHandle[]> {
    const arr = (await (scope
      ? this.callEngine((e, h, el, c) => h.query(e, c, el), [scope, chain], false)
      : this.callEngine((e, h, c) => h.query(e, c), [chain], false))) as unknown as JSHandle;
    const props = await arr.getProperties();
    void arr.dispose();
    const out: ElementHandle[] = [];
    const entries = [...props.entries()].filter(([k]) => /^\d+$/.test(k)).sort((x, y) => Number(x[0]) - Number(y[0]));
    for (const [, v] of entries) {
      const el = v.asElement();
      if (el) out.push(el as ElementHandle);
      else void v.dispose();
    }
    return out;
  }

  /**
   * Call `fn(engine, helpers, ...args)` in this engine context. Arguments are
   * JSON values or element handles (passed as the elements themselves).
   */
  async callEngine<R>(fn: (engine: any, helpers: any, ...args: any[]) => R | Promise<R>, args: unknown[], returnByValue = true): Promise<R> {
    await this.ensureEngine();
    const handles: JSHandle[] = [];
    const encoded = serializeArgument(args, (v) => v instanceof JSHandle, handles as unknown[]);
    const handleArgs = await Promise.all(handles.map((h) => this.adoptArgument(h)));
    const declaration = `async function (__ezArgs, ...__ezHandles) {
      ${KEEP_NAMES_SHIM}
      const __ezCodec = ${CODEC};
      const args = __ezCodec.deser(__ezArgs, __ezHandles);
      const r = await (${functionSource(fn)})(globalThis['${ENGINE_GLOBAL}'], globalThis['${HELPERS_GLOBAL}'], ...args);
      return ${returnByValue ? '__ezCodec.ser(r)' : 'r'};
    }`;
    let res: ProtocolResult;
    try {
      res = await this.session.send('Runtime.callFunctionOn', {
        functionDeclaration: declaration,
        executionContextId: this.id,
        arguments: [{ value: encoded }, ...handleArgs.map((h) => ({ objectId: h }))],
        returnByValue,
        awaitPromise: true,
        userGesture: true,
      });
    } catch (e) {
      throw this.rewrite(e as Error);
    }
    if (res.exceptionDetails) throw this.exceptionToError(res.exceptionDetails);
    if (returnByValue) return deserializeValue((res.result as RemoteObject).value) as R;
    return this.createHandle(res.result as RemoteObject) as unknown as R;
  }

  private rewrite(e: Error): Error {
    if (isContextGoneError(e)) {
      const err = new Error(CONTEXT_GONE_TEXT);
      err.name = 'Error';
      (err as Error & { contextGone?: boolean }).contextGone = true;
      return err;
    }
    return e;
  }

  /** Convert exceptionDetails into an Error carrying the page-side message and stack. */
  exceptionToError(details: any): Error {
    const ex = details.exception as RemoteObject | undefined;
    if (ex && ex.subtype === 'error' && ex.description) {
      const desc = ex.description;
      const firstLine = desc.split('\n')[0];
      const m = /^([\w$]*Error|[\w$]+Exception)(?::\s([\s\S]*))?$/.exec(firstLine);
      const err = new Error(m ? (m[2] ?? '') : firstLine);
      err.name = m ? m[1] : 'Error';
      const message = desc.slice(firstLine.length) ? `${m ? (m[2] ?? '') : firstLine}` : err.message;
      err.message = message;
      err.stack = desc;
      return err;
    }
    if (ex && 'value' in ex) {
      const err = new Error(typeof ex.value === 'string' ? ex.value : JSON.stringify(ex.value));
      return err;
    }
    const text = (details.text as string | undefined) ?? 'Evaluation failed';
    return new Error(ex?.description ? `${text} ${ex.description}` : text);
  }
}
