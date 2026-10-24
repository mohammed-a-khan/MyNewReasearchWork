/**
 * Contract between the EZTest browser driver (Node side) and the injected
 * selector / actionability engine (page side).
 *
 * This file holds TYPES ONLY plus two constants, so both sides can import it
 * without pulling code into the page.
 *
 * How the engine is shipped and installed
 * ---------------------------------------
 * - The engine module (`src/browser/injected/engine.ts`, owned by the selector
 *   engineer) exports `engineSource(): string`. The string is the JavaScript
 *   source of ONE EXPRESSION that evaluates to an object implementing
 *   {@link InjectedEngine}. It must be self-contained: no imports, no
 *   references to Node globals, nothing captured from the module scope.
 *   (Tip: write `function createEngine() { ... }` and return
 *   `'(' + createEngine.toString() + ')()'`; keep every helper inside it.
 *   The driver defines a no-op `__name` helper before evaluating, so the
 *   esbuild `keepNames` transform used by tsx / EZTest's testkit is harmless.)
 * - `src/browser/injected/index.ts` re-exports `engineSource` from the engine
 *   the driver uses.
 * - The driver evaluates the expression in an ISOLATED WORLD of every frame
 *   (CDP `Page.createIsolatedWorld`, world name {@link ENGINE_WORLD_NAME}) and
 *   stores the result at `globalThis[ENGINE_GLOBAL]`. Page scripts cannot see
 *   or tamper with it. It is re-installed lazily after every navigation.
 * - The engine shares the DOM with the page but not its JS globals; it must
 *   not rely on page-defined globals and must not modify page globals or the
 *   DOM (except scrolling, focus, and what an action requires).
 *
 * Selector chains
 * ---------------
 * A locator is a chain of steps, applied left to right to a working set of
 * elements. The working set starts as `[scope ?? document]`.
 * - Selection steps (css, xpath, role, text, label, placeholder, altText,
 *   title, testId) REPLACE the working set with the union, in document order
 *   without duplicates, of the matches found inside each element of the set
 *   (descendants only, never the scope element itself; for `xpath` the scope
 *   is the context node, so `//x` is global and `.//x` is scoped).
 * - Filter steps (nth, hasText, hasNotText, visible, has, hasNot) KEEP a subset
 *   of the working set.
 * - Open shadow roots are pierced by default by every step except xpath.
 * - `query` never throws for "no match"; it throws (an Error with a clear
 *   message) only for a malformed selector, which the driver reports as is.
 *
 * Text matching (`TextMatch`)
 * ---------------------------
 * - Whitespace is normalised first (trim, collapse runs of whitespace incl.
 *   NBSP to one space) on both sides.
 * - string + exact !== true : case-insensitive substring.
 * - string + exact === true : case-sensitive full-string equality.
 * - {regex, flags}          : `new RegExp(regex, flags).test(normalised)`.
 */

/** Name of the isolated world the engine lives in. */
export const ENGINE_WORLD_NAME = '__eztest_engine_world__';

/** Global property (inside the isolated world) holding the engine instance. */
export const ENGINE_GLOBAL = '__eztestEngine';

/** A regular expression in a JSON-safe form (`RegExp#source`, `RegExp#flags`). */
export interface RegexSource {
  regex: string;
  flags?: string;
}

export type TextMatch = string | RegexSource;

export interface CssStep { css: string }
export interface XPathStep { xpath: string }

/**
 * ARIA role (explicit `role=` attribute first token, else implicit role from
 * the HTML-AAM mapping). Hidden elements (not rendered, `aria-hidden`,
 * `inert`, `visibility:hidden`) are skipped unless `includeHidden`.
 * `name` matches the accessible name (accname 1.2) with TextMatch rules.
 * State filters compare with aria-* or native state (checkbox `checked`,
 * `indeterminate` = 'mixed', `<details open>` for expanded, `<option selected>`).
 * `disabled` honours native disabled, fieldset/optgroup inheritance and aria-disabled.
 */
export interface RoleStep {
  role: string;
  name?: TextMatch;
  exact?: boolean;
  checked?: boolean | 'mixed';
  pressed?: boolean | 'mixed';
  expanded?: boolean;
  selected?: boolean;
  disabled?: boolean;
  level?: number;
  includeHidden?: boolean;
}

/**
 * Elements whose rendered text (textContent of the element, with
 * `<script>/<style>/<template>` ignored, shadow DOM included) matches; for
 * substring and regex matches only the INNERMOST matching elements are kept
 * (an element is dropped when one of its child elements matches as well).
 * `<input type=button|submit>` match by their value.
 */
export interface TextStep { text: TextMatch; exact?: boolean }

/**
 * Form controls labelled by matching text: `<label for>`, wrapping `<label>`,
 * `aria-labelledby`, `aria-label`. The matched elements are the CONTROLS.
 */
export interface LabelStep { label: TextMatch; exact?: boolean }
/** Elements whose `placeholder` attribute matches. */
export interface PlaceholderStep { placeholder: TextMatch; exact?: boolean }
/** Elements (img, area, input[type=image]...) whose `alt` attribute matches. */
export interface AltTextStep { altText: TextMatch; exact?: boolean }
/** Elements whose `title` attribute matches. */
export interface TitleStep { title: TextMatch; exact?: boolean }
/** Elements whose attribute `attr` (default `data-testid`) matches; strings match exactly. */
export interface TestIdStep { testId: TextMatch; attr: string }

/**
 * Containers labelled by a text (selection step): landmarks and groups by
 * accessible name, a fieldset by its legend, or an element whose first
 * heading (h1-h6, role=heading, legend, summary, caption) has the text and
 * which holds more than the heading. Innermost containers only.
 */
export interface SectionStep { section: TextMatch; exact?: boolean }
/**
 * Rows containing a text (selection step): for each innermost element whose
 * text matches, its nearest row-like ancestor (tr, li, role=row / listitem /
 * option / article / treeitem, or an element repeated among its siblings
 * with the same tag and classes).
 */
export interface RowStep { row: TextMatch; exact?: boolean }
/**
 * Layout filter: keep elements above / below / left of / right of / near the
 * elements of `anchor` (evaluated from the same scope as the chain), by
 * bounding boxes. `near` defaults to 50px (`maxDistance`). With `nearest`
 * (default true) only the closest elements are kept; directional relations
 * prefer aligned elements (the off-axis gap counts three times).
 */
export interface LayoutStep {
  layout: 'above' | 'below' | 'leftOf' | 'rightOf' | 'near';
  anchor: SelectorChain;
  maxDistance?: number;
  nearest?: boolean;
}

/** Keep only the n-th element (0-based). -1 = last. Out of range = empty. */
export interface NthStep { nth: number }
/** Keep elements whose text (same normalisation as TextStep) matches (substring unless regex/exact). */
export interface HasTextStep { hasText: TextMatch; exact?: boolean }
/** Keep elements whose text does NOT match. */
export interface HasNotTextStep { hasNotText: TextMatch; exact?: boolean }
/** Keep visible (true) or hidden (false) elements, see {@link InjectedEngine.checkState}. */
export interface VisibleStep { visible: boolean }
/** Keep elements that contain (descendant-or-self is NOT counted: descendants only) a match of the chain. */
export interface HasStep { has: SelectorChain }
/** Keep elements that do not contain a match of the chain. */
export interface HasNotStep { hasNot: SelectorChain }

export type SelectorStep =
  | CssStep
  | XPathStep
  | RoleStep
  | TextStep
  | LabelStep
  | PlaceholderStep
  | AltTextStep
  | TitleStep
  | TestIdStep
  | NthStep
  | HasTextStep
  | HasNotTextStep
  | VisibleStep
  | HasStep
  | HasNotStep
  | SectionStep
  | RowStep
  | LayoutStep;

export type SelectorChain = SelectorStep[];

/** Actions the driver asks the engine to vet before performing them. */
export type ActionKind =
  | 'click'
  | 'dblclick'
  | 'hover'
  | 'tap'
  | 'check'
  | 'uncheck'
  | 'fill'
  | 'type'
  | 'clear'
  | 'selectOption'
  | 'selectText'
  | 'focus'
  | 'setInputFiles'
  | 'scrollIntoView'
  | 'screenshot'
  | 'dragTo';

/**
 * Checks per action (all actions first require the element to be connected):
 *
 * | action                                    | visible | stable | enabled | editable | receives events |
 * |-------------------------------------------|---------|--------|---------|----------|-----------------|
 * | click dblclick tap check uncheck dragTo   |   yes   |  yes   |   yes   |          |      yes        |
 * | hover                                     |   yes   |  yes   |         |          |      yes        |
 * | fill type clear                           |   yes   |        |   yes   |   yes    |                 |
 * | selectOption                              |   yes   |        |   yes   |          |                 |
 * | selectText scrollIntoView screenshot      |   yes   |  yes   |         |          |                 |
 * | focus setInputFiles                       |         |        |         |          |                 |
 *
 * - "visible": non-empty bounding box and not `visibility:hidden` (and for
 *   `display:contents` elements: any visible child).
 * - "stable": same bounding box over two consecutive animation frames.
 * - "enabled": not disabled (native, fieldset, aria-disabled on the element or
 *   an ancestor with a widget role).
 * - "editable": enabled and not readonly / aria-readonly; input, textarea,
 *   select or contenteditable.
 * - "receives events": the engine scrolls the element into view if needed,
 *   computes the action point (the centre of the first visible client rect,
 *   or `position` relative to the element's padding box top-left), hit-tests
 *   it (piercing shadow roots) and fails with `reason` naming the obstructing
 *   element (via `describe`) when the hit target is neither the element nor a
 *   descendant of it (a `<label>` hit counts for its control).
 *
 * `force: true` skips every check except "connected" and still scrolls into
 * view and reports `point`.
 */
export interface ActionabilityOptions {
  /** Offset from the element's top-left corner (CSS px). */
  position?: { x: number; y: number };
  force?: boolean;
}

export interface ActionabilityResult {
  ok: boolean;
  /** Human-readable reason when !ok, e.g. "the element is hidden", "<div class=modal> covers the element". */
  reason?: string;
  /** True when waiting may fix it (not visible yet, animating, covered). False for permanent failures (e.g. not an <input>). */
  retry?: boolean;
  /**
   * The action point in CSS px relative to the top-left of the element's
   * frame viewport (the driver adds iframe offsets). Present when ok and the
   * action needs a pointer (click, dblclick, hover, tap, check, uncheck, dragTo).
   */
  point?: { x: number; y: number };
}

export type ElementStateName = 'visible' | 'hidden' | 'enabled' | 'disabled' | 'editable' | 'checked' | 'unchecked' | 'focused' | 'attached';

/** The engine object installed at `globalThis[ENGINE_GLOBAL]` in the engine world. */
export interface InjectedEngine {
  /** Engine identifier, e.g. 'eztest-engine/1.0' (shown in debug logs). */
  readonly version: string;

  /** Resolve a chain. See "Selector chains" above. */
  query(chain: SelectorChain, scope?: Element | Document): Element[];

  /**
   * Vet an action; may be async (stability needs animation frames). Scrolls
   * the element into view for pointer actions, screenshot and scrollIntoView.
   */
  actionability(el: Element, action: ActionKind, options?: ActionabilityOptions): ActionabilityResult | Promise<ActionabilityResult>;

  /**
   * Element state used by isVisible / isEnabled / isChecked ... `checked`
   * throws an Error (not a checkbox or radio button) for elements without a
   * checked state (native or aria-checked on a checkbox/radio/switch role).
   */
  checkState(el: Element, state: ElementStateName): boolean;

  /** Accessible name (accname 1.2). */
  accessibleName(el: Element): string;

  /** ARIA role (explicit or implicit) or null. */
  role(el: Element): string | null;

  /** Short description for error messages, e.g. `<button id="save" class="primary">Save</button>`, max ~100 chars. */
  describe(el: Element): string;

  /**
   * OPTIONAL: an accessibility-tree snapshot of the subtree as YAML, e.g.
   *   - heading "Orders" [level=1]
   *   - button "Save"
   * The driver falls back to its own simple snapshot when absent.
   */
  ariaSnapshot?(el: Element): string;
}

/** What `engineSource()` returns: the source of an expression evaluating to an {@link InjectedEngine}. */
export type EngineSourceFactory = () => string;
