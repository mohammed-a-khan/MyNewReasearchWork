/**
 * Types for evaluate(): handles passed inside an argument arrive in the page
 * as the objects they point to, so the page function sees the argument
 * with every handle "unboxed".
 */
import type { ElementHandle, JSHandle } from './chromium/handles.js';

export type Unboxed<Arg> = Arg extends ElementHandle<infer T>
  ? T
  : Arg extends JSHandle<infer T>
    ? T
    : Arg extends Date | RegExp | URL | Error | string | number | boolean | bigint | symbol | null | undefined
      ? Arg
      : Arg extends [infer A0]
        ? [Unboxed<A0>]
        : Arg extends [infer A0, infer A1]
          ? [Unboxed<A0>, Unboxed<A1>]
          : Arg extends [infer A0, infer A1, infer A2]
            ? [Unboxed<A0>, Unboxed<A1>, Unboxed<A2>]
            : Arg extends Array<infer T>
              ? Array<Unboxed<T>>
              : Arg extends object
                ? { [K in keyof Arg]: Unboxed<Arg[K]> }
                : Arg;

/** A page function taking one argument (or an expression string). */
export type PageFunction<Arg, R> = string | ((arg: Unboxed<Arg>) => R | Promise<R>);

/** A page function called on an object (a handle's value, an element) plus one argument. */
export type PageFunctionOn<On, Arg, R> = string | ((on: On, arg: Unboxed<Arg>) => R | Promise<R>);
