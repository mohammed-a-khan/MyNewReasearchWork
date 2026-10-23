/**
 * Burned-in video overlays and WebVTT chapters for recorded journeys (G24).
 * When `recordVideo` is on, each step marks a chapter on the page's video and
 * shows a caption (step text) with a highlighted box around its target, drawn
 * through EZTest's own overlay script (src/browser/video/overlay.ts). The
 * overlay is hidden before evidence screenshots so it never pollutes them.
 */
import { OVERLAY_SCRIPT } from '../browser/index.js';
import type { Step } from '../core/index.js';
import type { Locator, Page } from '../browser/index.js';

type VideoPage = { video?: () => { markStep(text: string): void } | null };

/** True when this page is recording video (so overlays/chapters are worth drawing). */
export function pageHasVideo(page: Page): boolean {
  return !!(page as unknown as VideoPage).video?.();
}

/** Mark a chapter for this step and show its caption overlay. */
export async function overlayStepStart(page: Page, step: Step): Promise<void> {
  const vid = (page as unknown as VideoPage).video?.();
  if (!vid) return; // no video on this run
  try {
    vid.markStep(step.intent);
    await page.evaluate(OVERLAY_SCRIPT);
    await page.evaluate(
      (text: string) => (window as unknown as { __ezOverlay?: { show(t: string, b: unknown): void } }).__ezOverlay?.show(text, null),
      step.intent,
    );
  } catch {
    // overlays are best-effort: never fail a step for them
  }
}

/** Draw the highlighted box around the step's located target (caption stays). */
export async function overlayTarget(page: Page, step: Step, loc: Locator): Promise<void> {
  if (!pageHasVideo(page)) return;
  try {
    const box = await loc.boundingBox({ timeout: 500 }).catch(() => null);
    if (!box) return;
    await page.evaluate(
      (arg: { text: string; box: unknown }) => (window as unknown as { __ezOverlay?: { show(t: string, b: unknown): void } }).__ezOverlay?.show(arg.text, arg.box),
      { text: step.intent, box },
    );
  } catch {
    /* best-effort */
  }
}

/** Hide the overlay (before an evidence screenshot, or at step end). */
export async function overlayHide(page: Page): Promise<void> {
  const vid = (page as unknown as VideoPage).video?.();
  if (!vid) return;
  try {
    await page.evaluate(() => (window as unknown as { __ezOverlay?: { hide(): void } }).__ezOverlay?.hide());
  } catch {
    /* ignore */
  }
}
