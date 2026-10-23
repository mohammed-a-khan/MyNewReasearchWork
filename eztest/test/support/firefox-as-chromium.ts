/**
 * The EZTest browser module with Firefox behind `chromium`, for running the
 * whole suite on Firefox: with `EZTEST_BROWSER=firefox npm test` (`npm run test:firefox`),
 * testkit.config.mjs has the testkit's loader resolve imports of src/browser/index.ts to this module,
 * so every test that launches "chromium" (directly or through the runner)
 * drives Firefox over WebDriver BiDi instead.
 *
 * Command-line switches are Chromium's (`--site-per-process`,
 * `--window-size=...`); Firefox has none of them, so they are dropped here.
 */
import { firefox } from '../../src/browser/index.js';
import type { LaunchOptions } from '../../src/browser/types.js';

export * from '../../src/browser/index.js';

/** True while the suite runs on Firefox (tests that only make sense on Chromium skip themselves). */
export const RUNNING_ON_FIREFOX = true;

function firefoxArgs(args: string[] | undefined): string[] | undefined {
  if (!args) return args;
  // Chromium switches have no meaning for Firefox; keep only what is not a Chromium "--flag[=value]".
  return args.filter((a) => !/^--[a-z0-9-]+(=.*)?$/i.test(a) || /^--(width|height|private-window|kiosk)\b/.test(a));
}

type Launchable = typeof firefox;

const chromiumOnFirefox: Launchable = new Proxy(firefox, {
  get(target, prop, receiver) {
    if (prop === 'launch') return (o: LaunchOptions = {}) => target.launch({ ...o, channel: undefined, args: firefoxArgs(o.args) });
    if (prop === 'launchPersistentContext') return (dir: string, o: LaunchOptions & Record<string, unknown> = {}) => target.launchPersistentContext(dir, { ...o, channel: undefined, args: firefoxArgs(o.args) });
    const v = Reflect.get(target, prop, receiver);
    return typeof v === 'function' ? v.bind(target) : v;
  },
});

export const chromium = chromiumOnFirefox;
