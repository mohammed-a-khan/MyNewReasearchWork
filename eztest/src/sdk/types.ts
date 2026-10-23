/**
 * Public types of the EZTest TypeScript SDK (`eztest/sdk`).
 */
import type { Actor, Emulation } from '../core/index.js';
import type { Ui } from './ui.js';
import type { ApiSurface } from './api.js';
import type { DbSurface } from './db.js';
import type { DataSurface } from './data.js';
import type { FilesSurface } from './files.js';
import type { Dates } from './dates.js';
import type { IdentitySurface } from './identity.js';
import type { Vars } from './vars.js';
import type { Log } from './log.js';
import type { Expect } from './expect.js';
import type { Actors } from './actors.js';

/** Options of a code journey. Tags, filters, retries, quarantine, readiness and ADO publishing treat them like `.ez` headers. */
export interface JourneyOptions {
  /** Stable id (default: the slug of the name). */
  id?: string;
  description?: string;
  /** e.g. ['@billing', '@smoke']; '@TestCaseId:123' style tags publish to Azure DevOps. */
  tags?: string[];
  /** Identity Vault role the journey runs as (`ui.login()` with no role uses it). */
  role?: string;
  /** Risk 1 (low) .. 5 (critical), used by readiness and impact ranking. Default 3. */
  risk?: number;
  /** Requirement / work-item ids for traceability. */
  requirements?: string[];
  baseUrl?: string;
  /** Default variables (overridden by run variables and Examples rows). */
  variables?: Record<string, string>;
  /** Lenses applied to every UI step (a11y, visual, perf budgets ...). */
  lenses?: string[];
  emulation?: Emulation;
  /** Loader/spinner selectors waited out before every action and post-condition. */
  loaders?: string[];
  /** Inline Examples rows: the journey runs once per row; read the row with `vars.row()` or `data.row`. */
  examples?: Array<Record<string, string>>;
  /** External Examples rows (data file or named query), optionally filtered: `{ from: 'data/rows.json', where: 'runFlag = "Yes"' }`. */
  examplesFrom?: { from?: string; query?: string; connection?: string; params?: Record<string, string>; path?: string; sheet?: string; where?: string };
  /** Parameters when another journey runs this one (`Run journey "x" with a=1`). */
  params?: string[];
  /** Values handed back to a caller (keys the journey sets with `vars.set`). */
  returns?: string[];
  /** Run on a native app: 'android' | 'ios' (default web); `ui.*` calls then drive the device (docs/mobile.md). */
  platform?: 'web' | 'android' | 'ios';
  /** Native app under test: package / bundle id, or an .apk / .app to install. */
  app?: string;
  /** Per-journey launch settings (serial, udid, appId, clearData, launch). */
  capabilities?: Record<string, string | number | boolean>;
  /**
   * Actors of a multi-actor journey (docs/multi-actor.md): name -> role (string) or declaration.
   * Each gets its own browser context; use them as `actors.manager.ui.click(...)`.
   * The first one is the primary actor (plain `ui.*` calls run as it).
   */
  actors?: Record<string, string | Actor>;
  /** Browsers this journey runs on in a cross-browser run (default: all of the run's). */
  browsers?: string[];
}

/** Everything a journey or code step receives. The same objects are also exported from `eztest/sdk`. */
export interface SdkContext {
  ui: Ui;
  api: ApiSurface;
  db: DbSurface;
  data: DataSurface;
  files: FilesSurface;
  dates: Dates;
  identity: IdentitySurface;
  vars: Vars;
  log: Log;
  expect: Expect;
  /** A nested, reported step. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Run an `.ez`, YAML, JSON or library journey and get its Returns values. */
  run(ref: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Expectations inside `fn` are soft: failures are recorded, the journey continues and fails at the end. */
  soft<T>(fn: () => Promise<T>): Promise<T>;
  /** Multi-actor journeys: `actors.manager.ui.click(...)`, each actor in its own browser context. */
  actors: Actors;
}

/** The function behind a code journey. */
export type JourneyFn = (ctx: SdkContext) => Promise<unknown> | unknown;

/** A code step callable from `.ez` (`Run code "file.ts#name" with k=v as result`) and from code. */
export type CodeStepFn<P extends Record<string, unknown> = Record<string, string>, R = unknown> = (ctx: SdkContext, params: P) => Promise<R> | R;

/** One row of a table, a query, a CSV or a sheet. */
export type Row = Record<string, unknown>;
