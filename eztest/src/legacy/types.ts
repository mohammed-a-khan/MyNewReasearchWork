/**
 * What the terminal surface needs from a block-mode terminal, whatever the
 * protocol: the TN3270 client (src/legacy/tn3270) and the TN5250 client
 * (src/legacy/tn5250) both implement these, so the same plain-English steps,
 * field finding by label and healing work on IBM Z and IBM i green screens.
 */
import type { ScreenField, ScreenSnapshot } from './tn3270/screen.js';

export interface TerminalScreen {
  rows: number;
  cols: number;
  readonly size: number;
  /** 0-based buffer address of the cursor. */
  cursor: number;
  keyboardLocked: boolean;
  /** Bumped on every host write. */
  version: number;
  readonly formatted: boolean;
  addressOf(row: number, col: number): number;
  rowCol(addr: number): { row: number; col: number };
  fields(): ScreenField[];
  fieldAt(addr: number): ScreenField | undefined;
  readRange(addr: number, length: number): string;
  textRows(revealHidden?: boolean): string[];
  text(): string;
  snapshot(): ScreenSnapshot;
  /** Null the input field from `addr` to its end (Erase EOF). */
  eraseToEndOfField(addr: number): void;
}

export interface TerminalWaitOptions {
  timeoutMs?: number;
  settleMs?: number;
}

export interface TerminalClient {
  readonly protocol: 'tn3270' | 'tn5250';
  readonly screen: TerminalScreen;
  /** Normalise a key name to the protocol's attention key, or undefined when it is not one. */
  keyName(key: string): string | undefined;
  /** Human list of the keys the protocol accepts, for error messages. */
  readonly keyHelp: string;
  /** Keys handled locally by the terminal (no host round trip), e.g. Field Exit, Reset. Returns a description, or undefined. */
  localKey?(key: string): string | undefined;
  pressAndWait(key: string, o?: TerminalWaitOptions): Promise<void>;
  waitForScreen(o?: TerminalWaitOptions): Promise<void>;
  waitForText(text: string, o?: TerminalWaitOptions): Promise<void>;
  waitUntil(pred: () => boolean, timeoutMs: number, what: string): Promise<void>;
  typeAt(row: number, col: number, text: string, opts?: { replace?: boolean }): ScreenField;
  fill(field: ScreenField, text: string): void;
  field(label: string): import('./tn3270/fields.js').FieldMatch;
  moveCursor(row: number, col: number): void;
  text(): string;
  snapshot(): ScreenSnapshot;
  readonly negotiationTrace: string[];
  close(): void;
}
