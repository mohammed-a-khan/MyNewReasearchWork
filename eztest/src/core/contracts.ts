/**
 * Cross-module contracts. Modules depend on these interfaces, not on each
 * other's implementations, so any piece (secret store, logger, event sink)
 * can be swapped without touching the rest.
 */

// ---------------------------------------------------------------- secrets

/**
 * Secrets are referenced by handle. Code that drives the browser receives a
 * value only at the moment of use; logs and reports only ever see the handle.
 */
export interface SecretStore {
  readonly name: string;
  get(key: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------- logging

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------- events

export type EzEvent =
  | { type: 'run:start'; runId: string }
  | { type: 'run:end'; runId: string }
  | { type: 'journey:start'; journeyId: string; name: string }
  | { type: 'journey:end'; journeyId: string; status: string }
  | { type: 'step:start'; journeyId: string; stepId: string; intent: string; actor?: string }
  | { type: 'step:end'; journeyId: string; stepId: string; status: string; durationMs: number }
  | { type: 'heal'; journeyId: string; stepId: string; tier: string; verified: boolean }
  | { type: 'log'; level: LogLevel; message: string }
  | DebugEvent;

/** Events of the live step debugger (runner/debug). */
export type DebugEvent =
  | { type: 'debug.paused'; journeyId: string; stepIndex: number; stepId: string; phase: string; reason: string; intent: string; error?: string; actor?: string }
  | { type: 'debug.resumed'; journeyId: string; stepIndex: number; command: string }
  | { type: 'debug.stepStarted'; journeyId: string; stepIndex: number; stepId: string; intent: string; actor?: string }
  | { type: 'debug.stepFinished'; journeyId: string; stepIndex: number; stepId: string; status: string; durationMs: number }
  | { type: 'debug.stepSkipped'; journeyId: string; stepIndex: number; stepId: string }
  | { type: 'debug.stepEdited'; journeyId: string; stepIndex: number; stepId: string; intent: string }
  | { type: 'debug.evaluated'; journeyId: string; stepId: string; intent: string; status: string }
  | { type: 'debug.attached'; journeyId: string; attempt: number }
  | { type: 'debug.detached'; journeyId: string; attempt: number }
  | { type: 'debug.finished' };

export type EzEventListener = (e: EzEvent) => void;

export class EventBus {
  private listeners = new Set<EzEventListener>();
  on(l: EzEventListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: EzEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // A faulty listener must never break a run.
      }
    }
  }
}
