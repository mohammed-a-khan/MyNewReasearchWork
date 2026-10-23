/** Public result and option types of EZTest's accessibility engine. */
import type { A11yImpact } from './catalogue.js';
import type { WcagLevel } from './wcag.js';

export type { A11yImpact };

export interface A11yNode {
  /** Selector path: one entry per frame, shadow-root hops joined with " >>> ". */
  target: string[];
  html: string;
  /** Why this node failed (or needs review). */
  failureSummary?: string;
  /**
   * Bounding box in document coordinates (CSS pixels, scroll offset
   * included), i.e. aligned with a full-page screenshot. Absent when the
   * element could not be measured.
   */
  box?: { x: number; y: number; width: number; height: number };
}

export interface A11yFinding {
  ruleId: string;
  outcome: 'violation' | 'needs-review';
  impact: A11yImpact | null;
  /** Why it matters / how to fix. */
  description: string;
  /** What must be true. */
  help: string;
  helpUrl: string;
  /** WCAG success criteria this rule checks (or supports, for best practices). */
  sc: string[];
  tags: string[];
  nodes: A11yNode[];
  /** Nodes affected (`nodes` is capped at `maxNodes`). */
  nodeCount: number;
}

export interface A11yDynamicOptions {
  /** Tab through the page with the keyboard (keyboard traps, focus visible / order / obscured). */
  keyboard?: boolean;
  /** Resize the viewport to 320 CSS px and look for horizontal scrolling. */
  reflow?: boolean;
  /** Apply the WCAG 1.4.12 text-spacing overrides and look for clipped text. */
  textSpacing?: boolean;
}

export interface A11yScanOptions {
  /** e.g. ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"]. Only rules with one of these tags run. */
  tags?: string[];
  /** Conformance level: every WCAG rule at this level or below (plus best practices unless `bestPractice: false`). */
  level?: WcagLevel;
  bestPractice?: boolean;
  /** Run only these rule ids. */
  rules?: string[];
  /** CSS selectors (" >>> " pierces shadow roots): report only nodes inside them. */
  include?: string[];
  /** CSS selectors of subtrees to leave out. */
  exclude?: string[];
  disableRules?: string[];
  /** Report only findings at or above this impact. */
  minImpact?: A11yImpact;
  /** Checks that drive the page (true = all of them). Off by default: they press keys, resize the viewport and restyle temporarily. */
  dynamic?: boolean | A11yDynamicOptions;
  /** Upper bound on Tab presses in the keyboard walk (default 80). */
  maxTabStops?: number;
  /** Nodes kept per rule and outcome (default 100; counts stay exact). */
  maxNodes?: number;
}

export interface A11yScanResult {
  url: string;
  /** Engine name and version, e.g. "eztest-a11y/1.0.0". */
  engine: string;
  violations: A11yFinding[];
  needsReview: A11yFinding[];
  /** Number of rules with nodes that need review (same as needsReview.length). */
  incomplete: number;
  /** Rules that applied and found no violation. */
  passes: number;
  /** Rules that found nothing to check. */
  inapplicable: number;
  /** Violations by impact (rules). */
  counts: Record<A11yImpact, number>;
  /** Node totals per outcome. */
  totals: { violations: number; needsReview: number; passes: number };
  /** Rules run, in order. */
  rules: string[];
  /** Frames scanned through the driver (cross-origin), and frames that could not be scanned. */
  frames: { scanned: number; skipped: string[] };
  durationMs: number;
  /** Document size and device pixel ratio when the scan ran (to scale boxes onto screenshots). */
  page?: { width: number; height: number; dpr: number };
}
