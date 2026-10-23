/**
 * Multi-actor code journeys (docs/multi-actor.md):
 *
 * ```ts
 * journey('Two users chat', { actors: { alice: 'chat-user', bob: 'chat-user' } }, async ({ actors }) => {
 *   await actors.alice.ui.open('/chat');
 *   await actors.bob.ui.open('/chat');
 *   await Promise.all([                                   // both at the same time
 *     actors.alice.ui.fill('Message', 'Hi Bob'),
 *     actors.bob.ui.fill('Message', 'Hi Alice'),
 *   ]);
 *   await actors.bob.expect.page.toContainText('Hi Bob');
 * });
 * ```
 *
 * Every actor has its own browser context and session; its calls go through
 * the same runner path as plain `ui.*` calls (strict locating, verified
 * healing, evidence and trace labelled with the actor). `as('bob', fn)` runs a
 * whole block as bob.
 */
import { api } from './api.js';
import { expect } from './expect.js';
import { shared, withActor } from './runtime.js';
import { ui } from './ui.js';
import type { ApiSurface } from './api.js';
import type { Expect } from './expect.js';
import type { Ui } from './ui.js';

/** One actor of a multi-actor journey. */
export interface ActorHandle {
  readonly name: string;
  /** Browser actions in this actor's own context. */
  readonly ui: Ui;
  /** Expectations evaluated in this actor's page. */
  readonly expect: Expect;
  /** API calls made as this actor (same as `api`, labelled with the actor). */
  readonly api: ApiSurface;
  /** Run `fn` as this actor: every `ui` / `expect` call inside uses its context. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/** The journey's actors by name (`actors.manager`); an undeclared name is a plain web user. */
export type Actors = Record<string, ActorHandle>;

const hasFunctions = (v: object): boolean => {
  if (typeof v === 'function') return true;
  for (let o: object | null = v; o && o !== Object.prototype && o !== Array.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k === 'constructor') continue;
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (d && typeof d.value === 'function') return true;
    }
  }
  return false;
};

/**
 * `target` with every call made as `actor`. Results that are promises keep the actor (async work started
 * inside carries it); results with methods (matcher chains) are bound again; plain data is returned as is.
 */
function bind<T extends object>(target: T, actor: string): T {
  return new Proxy(target, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv) as unknown;
      if (typeof v === 'function') {
        return bind(function (this: unknown, ...args: unknown[]) {
          return callAs(actor, () => (v as (...a: unknown[]) => unknown).apply(this === undefined ? t : t, args));
        }, actor);
      }
      return v && typeof v === 'object' && hasFunctions(v) ? bind(v as object, actor) : v;
    },
    apply(t, thisArg, args) {
      return callAs(actor, () => Reflect.apply(t as (...a: unknown[]) => unknown, thisArg, args));
    },
  });
}

function callAs(actor: string, fn: () => unknown): unknown {
  const f = shared().als.getStore();
  if (!f) return fn(); // outside a journey the SDK call reports the missing context itself
  const r = shared().als.run({ ...f, actor }, fn);
  if (r instanceof Promise || typeof r !== 'object' || r === null) return r;
  return hasFunctions(r) ? bind(r, actor) : r;
}

const cache = new Map<string, ActorHandle>();

function handle(name: string): ActorHandle {
  let h = cache.get(name);
  if (!h) {
    h = { name, ui: bind(ui, name), expect: bind(expect, name), api: bind(api, name), run: (fn) => withActor(name, fn) };
    cache.set(name, h);
  }
  return h;
}

/** `actors.manager`, `actors['field-agent']`: handles are created on first use. */
export const actors: Actors = new Proxy({} as Actors, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (!/^[A-Za-z_][\w.-]*$/.test(prop)) throw new TypeError(`actors.${prop}: an actor name has letters, digits, _ . - only`);
    return handle(prop);
  },
  has: () => true,
});

/** Run `fn` as an actor (same as `actors[name].run(fn)`). */
export function as<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return handle(name).run(fn);
}
