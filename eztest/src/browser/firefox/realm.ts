/**
 * A WebDriver BiDi realm (one world of one document, or a worker) behind the
 * same ExecutionContext interface the CDP engine uses: evaluate, the
 * utility-world engine calls, element adoption, handle properties.
 *
 * Values travel as our tagged JSON (serializer.ts), carried in BiDi
 * LocalValues / RemoteValues: arrays, objects with string keys, strings,
 * finite numbers, booleans and null - nothing that BiDi serializes
 * differently from JSON. Element handles are BiDi shared references
 * (`sharedId`): valid in every realm of their document, so moving an element
 * between the main world and the sandbox costs nothing.
 */
import { ENGINE_GLOBAL } from '../injected/contract.js';
import { driverHelpersSource } from '../injected/driver-helpers.js';
import { engineSource } from '../injected/index.js';
import { KEEP_NAMES_SHIM, deserializeValue, functionSource, pageCodec, serializeArgument } from '../serializer.js';
import { ExecutionContext, type RemoteObject, type World } from '../chromium/exec-context.js';
import { ElementHandle, JSHandle } from '../chromium/handles.js';
import type { CrFrame } from '../chromium/frame.js';
import { cdpUnavailable } from './stubs.js';
import { isGoneBidiError, type BidiConnection } from './connection.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const HELPERS_GLOBAL = '__eztestDriver';
const CODEC = `(${pageCodec.toString()})()`;
/** Where ensureEngine() keeps the codec in the engine's realm. */
const CODEC_GLOBAL = '__eztestCodec';

/** A BiDi RemoteValue / LocalValue (loosely typed: the spec's union of shapes). */
export interface BidiValue {
  type: string;
  value?: any;
  handle?: string;
  sharedId?: string;
  internalId?: string;
}

/** JSON-compatible value -> BiDi LocalValue. */
export function toLocalValue(v: unknown): BidiValue {
  if (v === undefined) return { type: 'undefined' };
  if (v === null) return { type: 'null' };
  if (typeof v === 'string') return { type: 'string', value: v };
  if (typeof v === 'number') return { type: 'number', value: v };
  if (typeof v === 'boolean') return { type: 'boolean', value: v };
  if (Array.isArray(v)) return { type: 'array', value: v.map(toLocalValue) };
  return { type: 'object', value: Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toLocalValue(x)]) };
}

/** BiDi RemoteValue -> plain JS value (JSON-like data; other kinds become undefined). */
export function fromRemoteValue(r: BidiValue | undefined): unknown {
  if (!r) return undefined;
  switch (r.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string': case 'boolean': return r.value;
    case 'number':
      if (typeof r.value === 'number') return r.value;
      return r.value === 'NaN' ? NaN : r.value === 'Infinity' ? Infinity : r.value === '-Infinity' ? -Infinity : r.value === '-0' ? -0 : Number(r.value);
    case 'bigint': return BigInt(r.value);
    case 'array': return Array.isArray(r.value) ? r.value.map(fromRemoteValue) : [];
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const [k, x] of (r.value ?? []) as Array<[unknown, BidiValue]>) o[typeof k === 'string' ? k : String(fromRemoteValue(k as BidiValue))] = fromRemoteValue(x);
      return o;
    }
    case 'date': return new Date(r.value);
    case 'regexp': return new RegExp(r.value?.pattern ?? '', r.value?.flags ?? '');
    default: return undefined;
  }
}

/** CDP-shaped RemoteObject for a BiDi RemoteValue (what JSHandle stores). */
export function remoteObjectOf(r: BidiValue): RemoteObject & { sharedId?: string; bidiHandle?: string } {
  const t = r.type;
  if (t === 'undefined') return { type: 'undefined' };
  if (t === 'null') return { type: 'object', subtype: 'null', value: null };
  if (t === 'string' || t === 'boolean') return { type: t, value: r.value };
  if (t === 'number') {
    if (typeof r.value === 'number') return { type: 'number', value: r.value };
    return { type: 'number', unserializableValue: String(r.value) };
  }
  if (t === 'bigint') return { type: 'bigint', value: BigInt(r.value) };
  const subtype = t === 'node' ? 'node' : t === 'array' ? 'array' : t === 'error' ? 'error' : t === 'date' ? 'date' : t === 'regexp' ? 'regexp' : t === 'map' ? 'map' : t === 'set' ? 'set' : t === 'promise' ? 'promise' : t === 'window' ? 'window' : undefined;
  const id = r.sharedId ? `node:${r.sharedId}` : r.handle;
  return {
    type: t === 'function' ? 'function' : 'object',
    ...(subtype ? { subtype } : {}),
    ...(id ? { objectId: id } : {}),
    description: t === 'node' ? (r.value?.localName ?? 'node') : t,
    ...(r.sharedId ? { sharedId: r.sharedId } : {}),
    ...(r.handle ? { bidiHandle: r.handle } : {}),
    ...(id ? {} : { value: fromRemoteValue(r) }),
  };
}

/** Error for a page-side exception reported by BiDi. */
export function exceptionToError(details: any): Error {
  const text = String(details?.text ?? 'Evaluation failed');
  const m = /^(?:uncaught exception: )?([\w$]*(?:Error|Exception))(?::\s?([\s\S]*))?$/.exec(text);
  const err = new Error(m ? (m[2] ?? '') : text.replace(/^uncaught exception: /, ''));
  err.name = m ? m[1] : 'Error';
  const frames = (details?.stackTrace?.callFrames ?? []) as Array<{ functionName: string; url: string; lineNumber: number; columnNumber: number }>;
  err.stack = [`${err.name}: ${err.message}`, ...frames.map((f) => `    at ${f.functionName || '<anonymous>'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`)].join('\n');
  return err;
}

/** Do two URLs belong to one document (same URL up to the fragment, or a history API change of the same origin)? */
function sameDocument(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function contextGone(): Error {
  const err = new Error('Execution context was destroyed, most likely because of a navigation');
  (err as Error & { contextGone?: boolean }).contextGone = true;
  return err;
}

export class FfRealm extends ExecutionContext {
  private installingEngine?: Promise<void>;

  constructor(
    readonly bidi: BidiConnection,
    readonly realmId: string,
    /** Browsing context (frame) id, or undefined for worker realms. */
    readonly contextId: string | undefined,
    frame: CrFrame | undefined,
    world: World,
    worker?: unknown,
  ) {
    super(cdpUnavailable('Runtime') as never, 0, frame, world, worker);
  }

  /** The realm is gone (its document was replaced): forget it now, not when the event arrives, and say so. */
  private gone(e: unknown): Error {
    // A stale element reference ("no such node", or the agent's "realm is null" for a node whose
    // document went away) leaves the realm alive: the caller retries with a fresh element.
    if (/no such frame|Realm with id|discarded|does not exist|not found/i.test((e as Error).message) && !/no such node|no such handle|realm is null/i.test((e as Error).message)) {
      if (!this.disposed && this.frame) this.frame.contextDestroyed(this);
      this.disposed = true;
    }
    return contextGone();
  }

  private target(): { realm: string } {
    return { realm: this.realmId };
  }

  /** LocalValue that references a handle in this realm. */
  private reference(h: JSHandle): BidiValue {
    if (h.disposed) throw new Error('JSHandle is disposed');
    const remote = h.remote as RemoteObject & { sharedId?: string; bidiHandle?: string };
    if (remote.sharedId) {
      // Shared references work in every realm of the node's document.
      if (h.context !== this && !(h instanceof ElementHandle)) throw new Error('JSHandles can be evaluated only in the context they were created!');
      return { type: 'node', sharedId: remote.sharedId } as BidiValue;
    }
    if (h.context !== this) throw new Error('JSHandles can be evaluated only in the context they were created!');
    if (!remote.bidiHandle) throw new Error('JSHandle has no remote reference');
    return { type: 'object', handle: remote.bidiHandle } as BidiValue;
  }

  private static refArg(v: BidiValue): Record<string, string> {
    return v.sharedId ? { sharedId: v.sharedId } : { handle: v.handle! };
  }

  private async call(declaration: string, args: Array<Record<string, unknown>>, ownership: 'root' | 'none', serialization?: Record<string, unknown>): Promise<any> {
    try {
      return await this.bidi.send('script.callFunction', {
        functionDeclaration: declaration,
        awaitPromise: true,
        target: this.target(),
        arguments: args,
        resultOwnership: ownership,
        userActivation: true,
        ...(serialization ? { serializationOptions: serialization } : {}),
      });
    } catch (e) {
      if (this.world === 'worker' && /Realm with id .* not found/.test((e as Error).message)) {
        throw new Error('worker.evaluate: this Firefox does not run scripts in worker realms over WebDriver BiDi');
      }
      if (isGoneBidiError(e)) throw this.gone(e);
      throw e;
    }
  }

  /** Arguments: one tagged-JSON value plus the handles it references. */
  private encodeArgs(args: unknown[]): Array<Record<string, unknown>> {
    const handles: JSHandle[] = [];
    const encoded = serializeArgument(args, (v) => v instanceof JSHandle, handles as unknown[]);
    return [toLocalValue(encoded) as unknown as Record<string, unknown>, ...handles.map((h) => FfRealm.refArg(this.reference(h)))];
  }

  private ffWrapper(fnSrc: string, returnByValue: boolean, isExpression: boolean): string {
    const call = isExpression
      ? `let r = (${fnSrc}); if (typeof r === 'function') r = r(...args);`
      : `const fn = (${fnSrc}); let r = fn(...args);`;
    if (!returnByValue) {
      return `async function (__ezArgs, ...__ezHandles) {
        ${KEEP_NAMES_SHIM}
        const __ezCodec = ${CODEC};
        const args = __ezCodec.deser(__ezArgs, __ezHandles);
        ${call}
        return await r;
      }`;
    }
    // By value: exceptions are encoded too, so their name, message and stack survive exactly.
    return `async function (__ezArgs, ...__ezHandles) {
      ${KEEP_NAMES_SHIM}
      const __ezCodec = ${CODEC};
      try {
        const args = __ezCodec.deser(__ezArgs, __ezHandles);
        ${call}
        r = await r;
        return { ok: __ezCodec.ser(r), url: typeof location === 'object' ? String(location.href) : undefined };
      } catch (e) {
        return { err: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : { name: '', message: typeof e === 'string' ? e : String(e), value: __ezCodec.ser(e) } };
      }
    }`;
  }

  private decodeByValue(res: any, loaderBefore?: string): unknown {
    const out = fromRemoteValue(res.result) as { ok?: unknown; url?: string; err?: { name: string; message: string; stack?: string; value?: unknown } } | undefined;
    // The document's URL as the page sees it now. BiDi delivers a same-document navigation's event
    // after the result of the script that caused it (CDP before): keep frame.url() in step.
    // Only while this realm's document is still the frame's document (no navigation committed meanwhile).
    const f = this.frame;
    if (out?.url && f && !this.disposed && f.loaderId === loaderBefore && f.url() !== out.url && sameDocument(f.url(), out.url)) f.onSameDocument(out.url);
    if (out && 'err' in out && out.err) {
      const err = new Error(out.err.message);
      err.name = out.err.name || 'Error';
      if (out.err.stack !== undefined) err.stack = `${err.name}: ${err.message}\n${out.err.stack}`;
      if (out.err.value !== undefined) {
        err.name = '';
        err.stack = '';
      }
      throw err;
    }
    return deserializeValue(out?.ok);
  }

  override createHandle(obj: RemoteObject): JSHandle {
    if (obj.subtype === 'node' && this.frame) return new ElementHandle(this, obj);
    return new JSHandle(this, obj);
  }

  /** Wrap a BiDi RemoteValue as a handle of this realm. */
  handleFor(r: BidiValue): JSHandle {
    return this.createHandle(remoteObjectOf(r));
  }

  override async evaluate(fn: ((...a: any[]) => unknown) | string, args: unknown[], returnByValue: boolean): Promise<unknown> {
    const encodedArgs = this.encodeArgs(args);
    let fnSrc: string;
    let isExpression = false;
    if (typeof fn === 'string') {
      fnSrc = fn;
      isExpression = true;
    } else {
      fnSrc = functionSource(fn);
    }
    const loader = this.frame?.loaderId;
    const res = await this.call(this.ffWrapper(fnSrc, returnByValue, isExpression), encodedArgs, returnByValue ? 'none' : 'root', returnByValue ? undefined : { maxObjectDepth: 0, maxDomDepth: 0 });
    if (res.type === 'exception') {
      const err = exceptionToError(res.exceptionDetails);
      // A string with statements ("a; b") cannot be wrapped as an expression: run it as a script.
      if (isExpression && err.name === 'SyntaxError') return this.ffEvaluateStatements(fnSrc, returnByValue);
      throw err;
    }
    if (returnByValue) return this.decodeByValue(res, loader);
    return this.handleFor(res.result);
  }

  /** Run a classic script (statements, global declarations) in this realm; not subject to the page's CSP. */
  async runScript(source: string): Promise<void> {
    await this.ffEvaluateStatements(`${source}\n;undefined`, false).then((h) => (h as JSHandle).dispose());
  }

  private async ffEvaluateStatements(expression: string, returnByValue: boolean): Promise<unknown> {
    let res: any;
    try {
      res = await this.bidi.send('script.evaluate', { expression, target: this.target(), awaitPromise: true, resultOwnership: 'root', userActivation: true, serializationOptions: { maxObjectDepth: 0, maxDomDepth: 0 } });
    } catch (e) {
      if (isGoneBidiError(e)) throw this.gone(e);
      throw e;
    }
    if (res.type === 'exception') throw exceptionToError(res.exceptionDetails);
    const h = this.handleFor(res.result);
    if (!returnByValue) return h;
    try {
      return await h.jsonValue();
    } finally {
      await h.dispose();
    }
  }

  override async adoptElement(h: ElementHandle): Promise<ElementHandle> {
    if (h.context === this) return h;
    const remote = h.remote as RemoteObject & { sharedId?: string };
    if (!remote.sharedId) throw new Error('Element handle has no shared reference');
    // A shared reference is valid in every realm of the document: no round trip.
    return this.createHandle({ type: 'object', subtype: 'node', objectId: `node:${remote.sharedId}`, description: remote.description, ...{ sharedId: remote.sharedId } } as RemoteObject) as ElementHandle;
  }

  override ensureEngine(): Promise<void> {
    if (!this.installingEngine) {
      this.installingEngine = (async () => {
        const expression = `(() => { ${KEEP_NAMES_SHIM}
          if (!globalThis['${ENGINE_GLOBAL}']) globalThis['${ENGINE_GLOBAL}'] = ${engineSource()};
          if (!globalThis['${HELPERS_GLOBAL}']) globalThis['${HELPERS_GLOBAL}'] = ${driverHelpersSource()};
          if (!globalThis['${CODEC_GLOBAL}']) globalThis['${CODEC_GLOBAL}'] = ${CODEC};
          return true; })()`;
        let res: any;
        try {
          res = await this.bidi.send('script.evaluate', { expression, target: this.target(), awaitPromise: false, resultOwnership: 'none' });
        } catch (e) {
          if (isGoneBidiError(e)) throw this.gone(e);
          throw e;
        }
        if (res.type === 'exception') throw exceptionToError(res.exceptionDetails);
      })();
      this.installingEngine.catch(() => {
        this.installingEngine = undefined;
      });
    }
    return this.installingEngine;
  }

  override async callUtility<R>(fn: (engine: any, helpers: any, ...args: any[]) => R | Promise<R>, args: unknown[], returnByValue = true): Promise<R> {
    await this.ensureEngine();
    const encodedArgs = this.encodeArgs(args);
    const body = `const r = await (${functionSource(fn)})(globalThis['${ENGINE_GLOBAL}'], globalThis['${HELPERS_GLOBAL}'], ...args);`;
    // The codec lives next to the engine (installed once per realm): a short declaration is
    // compiled faster on every call than one carrying the codec's source.
    const declaration = returnByValue
      ? `async function (__ezArgs, ...__ezHandles) {
          ${KEEP_NAMES_SHIM}
          const __ezCodec = globalThis['${CODEC_GLOBAL}'];
          try {
            const args = __ezCodec.deser(__ezArgs, __ezHandles);
            ${body}
            return { ok: __ezCodec.ser(r), url: typeof location === 'object' ? String(location.href) : undefined };
          } catch (e) {
            return { err: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : { name: '', message: String(e) } };
          }
        }`
      : `async function (__ezArgs, ...__ezHandles) {
          ${KEEP_NAMES_SHIM}
          const __ezCodec = globalThis['${CODEC_GLOBAL}'];
          const args = __ezCodec.deser(__ezArgs, __ezHandles);
          ${body}
          return r;
        }`;
    const loader = this.frame?.loaderId;
    const res = await this.call(declaration, encodedArgs, returnByValue ? 'none' : 'root', returnByValue ? undefined : { maxObjectDepth: 0, maxDomDepth: 0 });
    if (res.type === 'exception') throw exceptionToError(res.exceptionDetails);
    if (returnByValue) return this.decodeByValue(res, loader) as R;
    return this.handleFor(res.result) as unknown as R;
  }

  /** One round trip: the matches come back as shared node references (no array handle, no getProperties, no disown). */
  override async queryElements(chain: unknown, scope?: ElementHandle): Promise<ElementHandle[]> {
    await this.ensureEngine();
    const args: Array<Record<string, unknown>> = [toLocalValue(JSON.parse(JSON.stringify(chain ?? null))) as unknown as Record<string, unknown>];
    if (scope) args.push(FfRealm.refArg(this.reference(scope)));
    const res = await this.call(
      `function (chain, scope) { return globalThis['${HELPERS_GLOBAL}'].query(globalThis['${ENGINE_GLOBAL}'], chain, scope); }`,
      args,
      'none',
      { maxObjectDepth: 1, maxDomDepth: 0 },
    );
    if (res.type === 'exception') throw exceptionToError(res.exceptionDetails);
    const out: ElementHandle[] = [];
    for (const v of (res.result?.value ?? []) as BidiValue[]) {
      if (v.type !== 'node' || !v.sharedId) continue;
      const h = this.handleFor(v);
      if (h instanceof ElementHandle) out.push(h);
    }
    return out;
  }

  override async getProperties(h: JSHandle): Promise<Map<string, JSHandle>> {
    const out = new Map<string, JSHandle>();
    if (!h.objectId) return out;
    // One call: own enumerable properties, one level deep. Nodes come back as shared
    // references and primitives as values; objects are fetched one by one as handles.
    const res = await this.call(
      'function (o) { const out = []; for (const k of Object.keys(o)) out.push([k, o[k]]); return out; }',
      [FfRealm.refArg(this.reference(h))],
      'none',
      { maxObjectDepth: 2, maxDomDepth: 0 },
    );
    if (res.type === 'exception') throw exceptionToError(res.exceptionDetails);
    for (const entry of (res.result?.value ?? []) as BidiValue[]) {
      const [k, v] = (entry.value ?? []) as [BidiValue, BidiValue];
      const key = String(fromRemoteValue(k));
      if (!v) continue;
      const primitive = ['undefined', 'null', 'string', 'number', 'boolean', 'bigint'].includes(v.type);
      if (primitive || v.type === 'node') {
        out.set(key, this.handleFor(v));
        continue;
      }
      const one = await this.call('function (o, k) { return o[k]; }', [FfRealm.refArg(this.reference(h)), { type: 'string', value: key }], 'root', { maxObjectDepth: 0, maxDomDepth: 0 });
      if (one.type === 'success') out.set(key, this.handleFor(one.result));
    }
    return out;
  }

  override async releaseHandle(h: JSHandle): Promise<void> {
    const handle = (h.remote as { bidiHandle?: string }).bidiHandle;
    if (!handle) return;
    // Fire and forget: nothing waits for the browser to free it.
    void this.bidi.send('script.disown', { handles: [handle], target: this.target() }).catch(() => undefined);
  }

  override async contentFrameOf(h: ElementHandle): Promise<CrFrame | null> {
    const res = await this.call(
      'function (el) { return el && (el.localName === "iframe" || el.localName === "frame") ? el.contentWindow : null; }',
      [FfRealm.refArg(this.reference(h))],
      'none',
      { maxObjectDepth: 0, maxDomDepth: 0 },
    );
    if (res.type === 'exception') throw exceptionToError(res.exceptionDetails);
    const id = res.result?.type === 'window' ? (res.result.value?.context as string | undefined) : undefined;
    if (!id) return null;
    const page = h.frame._page;
    return page.frameById(id) ?? (await page.waitForFrameById(id, 2000));
  }

  override async setInputFilePaths(h: ElementHandle, paths: string[]): Promise<void> {
    const ref = this.reference(h);
    if (!ref.sharedId || !this.contextId) throw new Error('setInputFiles needs an element of a frame');
    await this.bidi.send('input.setFiles', { context: this.contextId, element: { sharedId: ref.sharedId }, files: paths });
  }

  /** The element (in this realm) hosting the child browsing context `childId`, if any. */
  async ownerElementOf(childId: string): Promise<ElementHandle | undefined> {
    const res = await this.call(
      `function () {
        const out = [];
        const visit = (root) => {
          for (const el of root.querySelectorAll('iframe, frame')) out.push([el, el.contentWindow]);
          for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
        };
        visit(document);
        return out;
      }`,
      [],
      'none',
      { maxObjectDepth: 2, maxDomDepth: 0 },
    );
    if (res.type === 'exception') throw exceptionToError(res.exceptionDetails);
    for (const pair of (res.result?.value ?? []) as BidiValue[]) {
      const [el, win] = (pair.value ?? []) as [BidiValue, BidiValue];
      if (win?.type === 'window' && win.value?.context === childId && el?.sharedId) return this.handleFor(el) as ElementHandle;
    }
    return undefined;
  }
}
