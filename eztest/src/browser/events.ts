/**
 * Typed event emitter used by every driver object (Browser, BrowserContext,
 * Page, WebSocket ...), with `waitForEvent`.
 */
import { EventEmitter } from 'node:events';
import { TargetClosedError, TimeoutError } from './errors.js';
import { closedMessage, timeoutMessage } from './messages.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Listener = (...args: any[]) => unknown;

export interface WaitForEventOptions<T> {
  predicate?: (arg: T) => boolean | Promise<boolean>;
  timeout?: number;
}

export class TypedEmitter<E extends { [K in keyof E]: unknown }> {
  private readonly em = new EventEmitter();
  /** Wrapped listeners (so throwing listeners do not break protocol dispatch). */
  private readonly wrapped = new Map<string, Map<Listener, Listener>>();

  constructor() {
    this.em.setMaxListeners(0);
  }

  /** Default timeout for waitForEvent (overridden by pages / contexts). */
  protected eventTimeout(): number {
    return 30_000;
  }

  /** Event name that, when emitted, rejects pending waitForEvent calls (e.g. 'close'). */
  protected closeEventName(): string | undefined {
    return 'close';
  }

  private wrappers(event: string): Map<Listener, Listener> {
    let m = this.wrapped.get(event);
    if (!m) this.wrapped.set(event, (m = new Map()));
    return m;
  }

  private wrap(event: string, listener: Listener): Listener {
    let w = this.wrappers(event).get(listener);
    if (!w) {
      w = (...args: unknown[]) => {
        try {
          const r = listener.apply(this, args);
          if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch((e) => queueMicrotask(() => { throw e; }));
        } catch (e) {
          queueMicrotask(() => {
            throw e;
          });
        }
      };
      this.wrappers(event).set(listener, w);
    }
    return w;
  }

  on<K extends keyof E & string>(event: K, listener: (arg: E[K]) => unknown): this {
    this.em.on(event, this.wrap(event, listener as Listener));
    return this;
  }

  addListener<K extends keyof E & string>(event: K, listener: (arg: E[K]) => unknown): this {
    return this.on(event, listener);
  }

  prependListener<K extends keyof E & string>(event: K, listener: (arg: E[K]) => unknown): this {
    this.em.prependListener(event, this.wrap(event, listener as Listener));
    return this;
  }

  once<K extends keyof E & string>(event: K, listener: (arg: E[K]) => unknown): this {
    const w = this.wrap(event, listener as Listener);
    const once = (...args: unknown[]) => {
      this.em.off(event, once);
      this.wrappers(event).delete(listener as Listener);
      w(...args);
    };
    this.wrappers(event).set(listener as Listener, once);
    this.em.on(event, once);
    return this;
  }

  off<K extends keyof E & string>(event: K, listener: (arg: E[K]) => unknown): this {
    const w = this.wrappers(event).get(listener as Listener);
    if (w) {
      this.em.off(event, w);
      this.wrappers(event).delete(listener as Listener);
    }
    return this;
  }

  removeListener<K extends keyof E & string>(event: K, listener: (arg: E[K]) => unknown): this {
    return this.off(event, listener);
  }

  removeAllListeners(event?: keyof E & string): this {
    if (event) {
      this.em.removeAllListeners(event);
      this.wrapped.delete(event);
    } else {
      this.em.removeAllListeners();
      this.wrapped.clear();
    }
    return this;
  }

  listenerCount(event: keyof E & string): number {
    return this.em.listenerCount(event);
  }

  /** Internal: emit an event. */
  emitEvent<K extends keyof E & string>(event: K, arg: E[K]): void {
    this.em.emit(event, arg);
  }

  /**
   * Wait for the next `event` (that satisfies the predicate). Rejects on
   * timeout, and when the object closes before the event arrives.
   */
  waitForEvent<K extends keyof E & string>(
    event: K,
    optionsOrPredicate?: ((arg: E[K]) => boolean | Promise<boolean>) | WaitForEventOptions<E[K]>,
  ): Promise<E[K]> {
    const opts: WaitForEventOptions<E[K]> = typeof optionsOrPredicate === 'function' ? { predicate: optionsOrPredicate } : (optionsOrPredicate ?? {});
    const timeout = opts.timeout ?? this.eventTimeout();
    const closeName = this.closeEventName();
    return new Promise<E[K]>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.em.off(event, onEvent);
        if (closeName && closeName !== event) this.em.off(closeName, onClose);
      };
      const onEvent = async (arg: E[K]) => {
        try {
          if (opts.predicate && !(await opts.predicate(arg))) return;
        } catch (e) {
          cleanup();
          reject(e);
          return;
        }
        cleanup();
        resolve(arg);
      };
      const onClose = () => {
        cleanup();
        reject(new TargetClosedError(closedMessage(`waitForEvent('${event}')`)));
      };
      this.em.on(event, onEvent);
      if (closeName && closeName !== event) this.em.on(closeName, onClose);
      if (timeout > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(new TimeoutError(timeoutMessage(`waitForEvent('${event}')`, timeout, [`waiting for a "${event}" event`])));
        }, timeout);
      }
    });
  }
}
