/**
 * The full surface of EZTest's page-side engine: the driver contract
 * ({@link InjectedEngine}, in contract.ts, owned by the driver) plus the
 * extras the selector engine offers (descriptions, states, fingerprints,
 * value helpers). TYPES ONLY: imported by Node code and by the page bundle.
 */
import type {
  ActionabilityOptions,
  ActionabilityResult,
  ActionKind,
  InjectedEngine,
  SelectorStep,
  TextMatch,
} from './contract.js';

/**
 * Frame boundary marker. The engine does not cross frames: `queryDetailed`
 * stops at the first frame step and reports where it stopped, so the driver
 * can switch to the content frame of each matched `<iframe>`/`<frame>` and
 * continue with the rest of the chain there. `frame` may carry a CSS
 * selector for the frame element, applied before stopping (a shorthand for
 * `{css}, {frame: true}`).
 */
export interface FrameStep {
  frame: true | string;
}

export type EngineStep = SelectorStep | FrameStep;
export type EngineChain = EngineStep[];

export interface QueryResult {
  elements: Element[];
  /** Index in the chain of the frame step that stopped evaluation, when there was one. */
  frameAt?: number;
  /** The steps after the frame boundary, to be run inside each frame. */
  rest?: EngineChain;
}

/** Short action aliases accepted next to the contract's ActionKind names. */
export type EngineAction = ActionKind | 'select' | 'scroll';

export interface EngineActionabilityResult extends ActionabilityResult {
  /** Short CSS-like description of the element that receives the pointer instead of the target. */
  blocker?: string;
}

/** Same fields as `ElementFingerprint` in src/core/journey.ts (what the healer stores). */
export interface PageFingerprint {
  tag?: string;
  role?: string;
  name?: string;
  text?: string;
  id?: string;
  testId?: string;
  classes?: string[];
  attributes?: Record<string, string>;
  label?: string;
  placeholder?: string;
  path?: string;
  box?: { x: number; y: number; width: number; height: number };
}

export interface PageScannedElement {
  fingerprint: PageFingerprint;
  visible: boolean;
  enabled: boolean;
}

/** An option to select: a string matches value or label; objects match the given field. */
export type SelectOptionSpec = string | { value?: string; label?: string; index?: number };

export type EngineOutcome<T = void> = { ok: true; value?: T } | { ok: false; reason: string; retry: boolean };

export interface EztestEngine extends InjectedEngine {
  query(chain: EngineChain, scope?: Element | Document): Element[];
  queryDetailed(chain: EngineChain, scope?: Element | Document): QueryResult;
  actionability(el: Element, action: EngineAction, options?: ActionabilityOptions): Promise<EngineActionabilityResult>;

  accessibleDescription(el: Element): string;
  /** Rendered and visible to the user (box, visibility, display, content-visibility). opacity:0 counts as visible. */
  isVisible(el: Element): boolean;
  /** Excluded from the accessibility tree (aria-hidden, inert, not rendered, visibility:hidden). */
  isHiddenForAria(el: Element): boolean;

  checked(el: Element): boolean | 'mixed' | undefined;
  pressed(el: Element): boolean | 'mixed' | undefined;
  expanded(el: Element): boolean | undefined;
  selected(el: Element): boolean | undefined;
  disabled(el: Element): boolean;
  level(el: Element): number | undefined;
  editable(el: Element): boolean;

  fingerprint(el: Element): PageFingerprint;
  scan(els: Element[]): PageScannedElement[];

  /** Whitespace normalisation shared with the text matchers. */
  normalizeWhitespace(s: string): string;
  /** Shadow-inclusive text used by the text, hasText and hasNotText steps (normalised). */
  elementText(el: Element): string;
  innerText(el: Element): string;
  textContent(el: Element): string;
  matchesText(value: string, match: TextMatch, exact?: boolean): boolean;
  inputValue(el: Element): string;
  selectOptions(el: Element, options: SelectOptionSpec[]): EngineOutcome<string[]>;
  setChecked(el: Element, checked: boolean): EngineOutcome<boolean>;
  fill(el: Element, value: string): EngineOutcome;
  clear(el: Element): EngineOutcome;
  selectText(el: Element): void;
  focus(el: Element): void;
  dispatchEvent(el: Element, type: string, init?: Record<string, unknown>): boolean;
}
