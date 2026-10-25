/**
 * `journey()`, `step()`, `run()`, `soft()` and `codeStep()`.
 */
import { api } from './api.js';
import { graphql } from './graphql.js';
import { callSite } from './callsite.js';
import { data } from './data.js';
import { dates } from './dates.js';
import { db } from './db.js';
import { expect } from './expect.js';
import { files } from './files.js';
import { identity } from './identity.js';
import { log } from './log.js';
import { frame, shared, withSoft } from './runtime.js';
import type { CodeStepFn, JourneyFn, JourneyOptions, SdkContext } from './types.js';
import { ui } from './ui.js';
import { vars } from './vars.js';
import { actors } from './actors.js';
import { cleanup } from './cleanup.js';

/**
 * Declare a code journey. `eztest run` discovers `*.journey.ts` files in the
 * journeys directory; each `journey()` call in them is one journey, filtered,
 * retried, quarantined, reported and published like an `.ez` journey.
 */
export function journey(name: string, fn: JourneyFn): void;
export function journey(name: string, options: JourneyOptions, fn: JourneyFn): void;
export function journey(name: string, a: JourneyOptions | JourneyFn, b?: JourneyFn): void {
  const options = typeof a === 'function' ? {} : a;
  const fn = typeof a === 'function' ? a : b;
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('journey() needs a name');
  if (typeof fn !== 'function') throw new TypeError(`journey("${name}") needs a function`);
  const s = shared();
  const site = callSite();
  const file = s.loading.at(-1) ?? site?.file ?? '';
  const list = s.registry.get(file) ?? [];
  if (list.some((r) => r.name === name)) throw new Error(`journey("${name}") is declared twice in ${file}`);
  list.push({ name, options, fn, file, ...(site?.line ? { line: site.line } : {}) });
  s.registry.set(file, list);
}

/** A nested, reported step: timing, status and its own children in reports, trace and Studio. */
export function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const f = frame('step()');
  return f.host.group(name, fn, callSite());
}

/** Run an `.ez`, YAML, JSON or library journey (by id, name or file) and get its Returns values. */
export function run(ref: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const f = frame('run()');
  return f.host.runJourney(ref, params, callSite());
}

export interface PollOptions {
  /** Give up after this many ms (default 10 000). */
  within?: number;
  /** Wait this long between tries (default 500 ms). */
  every?: number;
  /** What is being waited for: the step's name and the failure message ("the visit is confirmed"). */
  message?: string;
}

/**
 * Call `fn` until it returns a truthy value (or, when it returns nothing, until it stops throwing), every
 * `every` ms for at most `within` ms. One reported step ("Poll until the visit is confirmed") with the last
 * try's SDK calls as children; earlier failed tries are warnings. Returns what `fn` returned.
 */
export async function poll<T>(fn: () => Promise<T> | T, o: PollOptions = {}): Promise<T> {
  const f = frame('poll()');
  const message = o.message ?? 'the condition holds';
  const name = `Poll until ${message}`;
  const once = async (): Promise<T> => {
    const v = await fn();
    if (v === false || v === null || v === 0 || v === '') throw new Error(`not yet: ${message}`);
    return v;
  };
  if (!f.host.retrying) throw new TypeError('poll() needs EZTest\'s runner');
  return f.host.retrying(name, once, { within: o.within ?? 10_000, every: o.every ?? 500, message: `${message} did not happen within ${o.within ?? 10_000} ms` }, callSite());
}

/** Expectations inside `fn` are soft: failures are recorded, the journey continues and fails at the end. */
export function soft<T>(fn: () => Promise<T>): Promise<T> {
  return withSoft(fn);
}

/**
 * A typed code step for `.ez` (`Run code "steps/billing.ts#settleOverdue" with region="EU" as result`)
 * and for other code. Parameters from `.ez` arrive as strings.
 */
export function codeStep<P extends Record<string, unknown> = Record<string, string>, R = unknown>(fn: CodeStepFn<P, R>): CodeStepFn<P, R> {
  return fn;
}

/**
 * One instance of a class per journey attempt (created on first use). Migrated
 * step-definition classes keep their fields across the steps of a scenario.
 */
export function journeyInstance<T>(ctor: new () => T): T {
  const map = frame('journeyInstance()').host.instances();
  let v = map.get(ctor) as T | undefined;
  if (v === undefined) map.set(ctor, (v = new ctor()));
  return v;
}

/**
 * A step the importer could not translate. It always throws when reached (it
 * is typed `any` so the surrounding migrated code still typechecks); the
 * original code and its file:line are kept in a comment next to the call.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function todo(reason: string, where?: string): any {
  throw new Error(`Not migrated yet: ${reason}${where ? ` (${where})` : ''}`);
}

/** The context object every journey and code step receives. */
export const sdk: SdkContext = { ui, api, graphql, db, data, files, dates, identity, vars, log, expect, step, run, soft, actors, cleanup, poll };
