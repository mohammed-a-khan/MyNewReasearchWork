/**
 * Touch gestures as finger paths (the EZTest agent gesture format): tap,
 * double tap, long press, swipe, drag and two-finger pinch. The Android agent
 * injects them as MotionEvents through UiAutomation; the iOS agent replays
 * them with XCUICoordinate press/drag.
 */
import type { Gesture, GesturePoint, Rect } from './session.js';

export interface Point {
  x: number;
  y: number;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

const pt = (p: Point, t: number): GesturePoint => ({ x: Math.round(p.x), y: Math.round(p.y), t: Math.round(t) });

export function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function tap(p: Point): Gesture {
  return { fingers: [[pt(p, 0), pt(p, 50)]] };
}

/** Two taps 130 ms apart (one finger path lifts between them: two fingers entries in sequence). */
export function doubleTap(p: Point): Gesture {
  return { fingers: [[pt(p, 0), pt(p, 40)], [pt(p, 170), pt(p, 210)]] };
}

export function longPress(p: Point, durationMs = 1000): Gesture {
  return { fingers: [[pt(p, 0), pt(p, durationMs)]] };
}

export function swipe(from: Point, to: Point, durationMs = 400): Gesture {
  return { fingers: [[pt(from, 0), pt(from, 80), pt(to, 80 + durationMs)]] };
}

/** Drag: hold on the source, move to the destination, release. */
export function drag(from: Point, to: Point, holdMs = 600, durationMs = 600): Gesture {
  return { fingers: [[pt(from, 0), pt(from, holdMs), pt(to, holdMs + durationMs), pt(to, holdMs + durationMs + 100)]] };
}

/** A directional swipe across an area. "up" means the finger moves up (the content scrolls down). */
export function directionalSwipe(area: Rect, direction: Direction, ratio = 0.6, durationMs = 400): Gesture {
  const c = center(area);
  const dx = (area.width * ratio) / 2;
  const dy = (area.height * ratio) / 2;
  const from: Point = { ...c };
  const to: Point = { ...c };
  if (direction === 'up') { from.y = c.y + dy; to.y = c.y - dy; }
  if (direction === 'down') { from.y = c.y - dy; to.y = c.y + dy; }
  if (direction === 'left') { from.x = c.x + dx; to.x = c.x - dx; }
  if (direction === 'right') { from.x = c.x - dx; to.x = c.x + dx; }
  return swipe(from, to, durationMs);
}

/** Two-finger pinch: "in" moves the fingers together (zoom out), "out" spreads them (zoom in). */
export function pinch(area: Rect, direction: 'in' | 'out', durationMs = 500): Gesture {
  const c = center(area);
  const far = Math.max(20, Math.min(area.width, area.height) * 0.35);
  const near = Math.max(5, far * 0.2);
  const [start, end] = direction === 'in' ? [far, near] : [near, far];
  const f = (sign: number) => [pt({ x: c.x + sign * start, y: c.y }, 0), pt({ x: c.x + sign * end, y: c.y }, durationMs)];
  return { fingers: [f(-1), f(1)] };
}

/** Two rectangles overlap (an element is on screen when it overlaps the window). */
export function intersects(a: Rect, b: Rect): boolean {
  return a.width > 0 && a.height > 0 && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
