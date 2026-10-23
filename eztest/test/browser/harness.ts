/**
 * Test harness for the page-side engine: the EZTest driver loads pages into
 * a real Chromium, and the tests call the engine global directly.
 */
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { engineSource } from '../../src/browser/injected/engine.js';
import { ENGINE_GLOBAL } from '../../src/browser/injected/contract.js';

export { ENGINE_GLOBAL };

export async function launch(): Promise<Browser> {
  return chromium.launch();
}

/** Load `html` (a full document is built around it) and install the engine. */
export async function load(page: Page, html: string, setup?: string): Promise<void> {
  await page.setContent(html.startsWith('<!doctype') ? html : `<!doctype html><html><head><meta charset=utf-8></head><body>${html}</body></html>`);
  await install(page);
  if (setup) {
    await page.evaluate(`(() => { const t = document.getElementById('t'); const h = document.getElementById('h'); ${setup}; })()`);
  }
}

export async function install(page: Page): Promise<void> {
  await page.evaluate(`globalThis[${JSON.stringify(ENGINE_GLOBAL)}] = ${engineSource()}; undefined`);
}

/**
 * Evaluate an expression in the page with `E` bound to the engine. Written as
 * a string so no test-toolchain helpers leak into the page.
 */
export async function ev<T>(page: Page, body: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    `(() => { const E = globalThis[${JSON.stringify(ENGINE_GLOBAL)}]; const ARG = ${JSON.stringify(arg ?? null)}; ${body} })()`,
  ) as Promise<T>;
}

/** Labels (`id`, else `describe`) of what a chain matches, in order. */
export async function q(page: Page, chain: unknown[], scopeCss?: string): Promise<string[]> {
  return ev<string[]>(
    page,
    `const scope = ARG.scope ? document.querySelector(ARG.scope) : undefined;
     return E.query(ARG.chain, scope).map((e) => e.id || E.describe(e));`,
    { chain, scope: scopeCss ?? null },
  );
}
