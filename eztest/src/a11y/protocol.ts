/**
 * What the Node side sends to the in-page accessibility engine and what it
 * returns. Types only: the page bundle imports nothing at run time from here.
 */

export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageNode {
  /** Selector path: one entry per document (frames), shadow hops joined with " >>> ". */
  target: string[];
  /** Start tag of the element (truncated). */
  html: string;
  /** Why this node failed or needs review, written for people. */
  message: string;
  /** Border box relative to the viewport of the document the engine ran in. */
  box?: PageBox;
}

export interface PageRuleResult {
  fail: PageNode[];
  review: PageNode[];
  /** Totals (the node lists are capped). */
  failCount: number;
  reviewCount: number;
  pass: number;
}

export interface PageRunOptions {
  rules: string[];
  include?: string[];
  exclude?: string[];
  /** Apply the 1.4.12 text-spacing overrides and look for clipped text. */
  textSpacing?: boolean;
  /** Node lists per rule and outcome are cut at this length (default 100). */
  maxNodes?: number;
}

export interface PageRunResult {
  engine: string;
  url: string;
  /** True when this document sits in a same-origin parent that the parent's run already covered. */
  coveredByParent: boolean;
  rules: Record<string, PageRuleResult>;
  scroll: { x: number; y: number };
  size: { width: number; height: number };
  dpr: number;
  /** Elements examined (all documents reached from this one). */
  elements: number;
  ms: number;
  /** Milliseconds per rule (and for collecting the elements). */
  timings?: Record<string, number>;
}

/** One keyboard focus stop, as seen after a Tab press. */
export interface FocusStop {
  /** Stable per-element key for the walk (0 = no element focused: the document). */
  key: number;
  target: string[];
  html: string;
  label: string;
  box?: PageBox;
  /** Focus went into a frame this document cannot see into. */
  inOpaqueFrame: boolean;
  visible: boolean;
  /** The focused rendering differs from the unfocused one. */
  indicator: boolean | null;
  /** Every sampled point of the element is covered by other content. */
  obscured: boolean;
  /** Inside an open modal dialog. */
  inModal: boolean;
  /** Position in shadow-including document order. */
  order: number;
  /** The last tab stop of the document (Tab from it leaves the page). */
  last: boolean;
}

export interface ReflowResult {
  viewportWidth: number;
  scrollWidth: number;
  offenders: Array<PageNode & { exempt: boolean }>;
}
