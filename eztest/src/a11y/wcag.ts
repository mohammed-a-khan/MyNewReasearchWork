/**
 * The WCAG 2.2 success criteria EZTest's accessibility rules map to: number,
 * short title, conformance level, the WCAG version that introduced it, and
 * the slug of its W3C "Understanding" page.
 */

export type WcagLevel = 'A' | 'AA' | 'AAA';

export interface SuccessCriterion {
  sc: string;
  title: string;
  level: WcagLevel;
  /** WCAG version that introduced the criterion. */
  since: '2.0' | '2.1' | '2.2';
  slug: string;
}

const list: SuccessCriterion[] = [
  { sc: '1.1.1', title: 'Non-text Content', level: 'A', since: '2.0', slug: 'non-text-content' },
  { sc: '1.2.1', title: 'Audio-only and Video-only (Prerecorded)', level: 'A', since: '2.0', slug: 'audio-only-and-video-only-prerecorded' },
  { sc: '1.2.2', title: 'Captions (Prerecorded)', level: 'A', since: '2.0', slug: 'captions-prerecorded' },
  { sc: '1.2.5', title: 'Audio Description (Prerecorded)', level: 'AA', since: '2.0', slug: 'audio-description-prerecorded' },
  { sc: '1.3.1', title: 'Info and Relationships', level: 'A', since: '2.0', slug: 'info-and-relationships' },
  { sc: '1.3.4', title: 'Orientation', level: 'AA', since: '2.1', slug: 'orientation' },
  { sc: '1.3.5', title: 'Identify Input Purpose', level: 'AA', since: '2.1', slug: 'identify-input-purpose' },
  { sc: '1.4.1', title: 'Use of Color', level: 'A', since: '2.0', slug: 'use-of-color' },
  { sc: '1.4.2', title: 'Audio Control', level: 'A', since: '2.0', slug: 'audio-control' },
  { sc: '1.4.3', title: 'Contrast (Minimum)', level: 'AA', since: '2.0', slug: 'contrast-minimum' },
  { sc: '1.4.4', title: 'Resize Text', level: 'AA', since: '2.0', slug: 'resize-text' },
  { sc: '1.4.6', title: 'Contrast (Enhanced)', level: 'AAA', since: '2.0', slug: 'contrast-enhanced' },
  { sc: '1.4.10', title: 'Reflow', level: 'AA', since: '2.1', slug: 'reflow' },
  { sc: '1.4.11', title: 'Non-text Contrast', level: 'AA', since: '2.1', slug: 'non-text-contrast' },
  { sc: '1.4.12', title: 'Text Spacing', level: 'AA', since: '2.1', slug: 'text-spacing' },
  { sc: '2.1.1', title: 'Keyboard', level: 'A', since: '2.0', slug: 'keyboard' },
  { sc: '2.1.2', title: 'No Keyboard Trap', level: 'A', since: '2.0', slug: 'no-keyboard-trap' },
  { sc: '2.2.1', title: 'Timing Adjustable', level: 'A', since: '2.0', slug: 'timing-adjustable' },
  { sc: '2.2.2', title: 'Pause, Stop, Hide', level: 'A', since: '2.0', slug: 'pause-stop-hide' },
  { sc: '2.4.1', title: 'Bypass Blocks', level: 'A', since: '2.0', slug: 'bypass-blocks' },
  { sc: '2.4.2', title: 'Page Titled', level: 'A', since: '2.0', slug: 'page-titled' },
  { sc: '2.4.3', title: 'Focus Order', level: 'A', since: '2.0', slug: 'focus-order' },
  { sc: '2.4.4', title: 'Link Purpose (In Context)', level: 'A', since: '2.0', slug: 'link-purpose-in-context' },
  { sc: '2.4.6', title: 'Headings and Labels', level: 'AA', since: '2.0', slug: 'headings-and-labels' },
  { sc: '2.4.7', title: 'Focus Visible', level: 'AA', since: '2.0', slug: 'focus-visible' },
  { sc: '2.4.11', title: 'Focus Not Obscured (Minimum)', level: 'AA', since: '2.2', slug: 'focus-not-obscured-minimum' },
  { sc: '2.5.3', title: 'Label in Name', level: 'A', since: '2.1', slug: 'label-in-name' },
  { sc: '2.5.5', title: 'Target Size (Enhanced)', level: 'AAA', since: '2.1', slug: 'target-size-enhanced' },
  { sc: '2.5.8', title: 'Target Size (Minimum)', level: 'AA', since: '2.2', slug: 'target-size-minimum' },
  { sc: '3.1.1', title: 'Language of Page', level: 'A', since: '2.0', slug: 'language-of-page' },
  { sc: '3.1.2', title: 'Language of Parts', level: 'AA', since: '2.0', slug: 'language-of-parts' },
  { sc: '3.3.2', title: 'Labels or Instructions', level: 'A', since: '2.0', slug: 'labels-or-instructions' },
  { sc: '4.1.2', title: 'Name, Role, Value', level: 'A', since: '2.0', slug: 'name-role-value' },
];

export const SUCCESS_CRITERIA: ReadonlyMap<string, SuccessCriterion> = new Map(list.map((c) => [c.sc, c]));

export function criterion(sc: string): SuccessCriterion {
  const c = SUCCESS_CRITERIA.get(sc);
  if (!c) throw new Error(`Unknown WCAG success criterion ${sc}`);
  return c;
}

/** "https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html" */
export function understandingUrl(sc: string): string {
  return `https://www.w3.org/WAI/WCAG22/Understanding/${criterion(sc).slug}.html`;
}

/** Tag of one criterion: "1.4.3" -> "wcag143". */
export function scTag(sc: string): string {
  return `wcag${sc.replace(/\./g, '')}`;
}

/** Version and level tag of a criterion: 2.0 A -> "wcag2a", 2.1 AA -> "wcag21aa", 2.2 AA -> "wcag22aa". */
export function levelTag(sc: string): string {
  const c = criterion(sc);
  const v = c.since === '2.0' ? '2' : c.since.replace('.', '');
  return `wcag${v}${c.level.toLowerCase()}`;
}

const LEVEL_ORDER: WcagLevel[] = ['A', 'AA', 'AAA'];
export function levelAtMost(level: WcagLevel, max: WcagLevel): boolean {
  return LEVEL_ORDER.indexOf(level) <= LEVEL_ORDER.indexOf(max);
}
