/**
 * A tiny reactive store: hold a value, notify subscribers on change, derive
 * read-only views. Enough for a page to re-render the parts that changed.
 */
export type Unsubscribe = () => void;

export interface Readable<T> {
  get(): T;
  /** Call `fn` on every change (and immediately unless `immediate` is false). */
  subscribe(fn: (value: T, previous: T | undefined) => void, immediate?: boolean): Unsubscribe;
}

export class Store<T> implements Readable<T> {
  private readonly subs = new Set<(v: T, prev: T | undefined) => void>();

  constructor(
    private value: T,
    private readonly equals: (a: T, b: T) => boolean = Object.is,
  ) {}

  get(): T {
    return this.value;
  }

  set(next: T): void {
    if (this.equals(this.value, next)) return;
    const prev = this.value;
    this.value = next;
    for (const s of [...this.subs]) {
      try {
        s(next, prev);
      } catch (e) {
        console.error('store subscriber failed', e);
      }
    }
  }

  update(fn: (v: T) => T): void {
    this.set(fn(this.value));
  }

  /** Shallow-merge into an object value. */
  patch(this: Store<T & object>, part: Partial<T>): void {
    this.set({ ...this.value, ...part });
  }

  subscribe(fn: (value: T, previous: T | undefined) => void, immediate = true): Unsubscribe {
    this.subs.add(fn);
    if (immediate) fn(this.value, undefined);
    return () => this.subs.delete(fn);
  }

  /** A derived read-only store that only notifies when the selected value changes. */
  select<U>(fn: (v: T) => U, equals: (a: U, b: U) => boolean = Object.is): Readable<U> {
    return derived([this as Readable<T>], ([v]) => fn(v as T), equals);
  }
}

export function store<T>(value: T, equals?: (a: T, b: T) => boolean): Store<T> {
  return new Store(value, equals);
}

/** A read-only store computed from other stores. */
export function derived<S extends Readable<unknown>[], U>(
  sources: [...S],
  fn: (values: { [K in keyof S]: S[K] extends Readable<infer V> ? V : never }) => U,
  equals: (a: U, b: U) => boolean = Object.is,
): Readable<U> {
  const read = () => fn(sources.map((s) => s.get()) as never);
  const out = new Store<U>(read(), equals);
  for (const s of sources) s.subscribe(() => out.set(read()), false);
  return { get: () => out.get(), subscribe: (f, imm) => out.subscribe(f, imm) };
}

/** Collects unsubscribe/cleanup functions and runs them all at once. */
export class Disposer {
  private readonly fns: Array<() => void> = [];

  add(fn: (() => void) | undefined | void): void {
    if (fn) this.fns.push(fn);
  }

  dispose(): void {
    for (const f of this.fns.splice(0).reverse()) {
      try {
        f();
      } catch {
        // ignore
      }
    }
  }
}
