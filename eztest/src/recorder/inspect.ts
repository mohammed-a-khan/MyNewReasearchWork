/** Inspect an element the way the recorder does (used by tests and tooling). */
import type { Locator } from '../browser/index.js';
import { pageScript, type ElementInfo } from './page-script.js';
import { buildTarget, type RecordedTarget } from './target.js';

/** What the recorder's in-page code computes for the element `locator` points at. */
export async function inspectElement(locator: Locator): Promise<ElementInfo> {
  const handle = await locator.elementHandle();
  if (!handle) throw new Error('inspectElement: locator matched no element');
  try {
    const frame = await handle.ownerFrame();
    if (!frame) throw new Error('inspectElement: element is not attached to a frame');
    await frame.evaluate(pageScript(null));
    return (await handle.evaluate((el) => (window as unknown as { __ezRecorder: { info(e: Element): unknown } }).__ezRecorder.info(el))) as ElementInfo;
  } finally {
    await handle.dispose();
  }
}

/** The descriptions and locator candidates the recorder would record for this element. */
export async function describeElement(locator: Locator): Promise<RecordedTarget & { info: ElementInfo }> {
  const info = await inspectElement(locator);
  return { ...buildTarget(info), info };
}
