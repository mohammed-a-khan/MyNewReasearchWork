/**
 * Configuration of EZTest's own test suite, run by EZTest's testkit
 * (tools/testkit, a development tool of this repository; EZTest does not use
 * it at run time and does not ship it).
 *
 *   npm test                                  # on Chromium (CDP)
 *   EZTEST_BROWSER=firefox npm test           # the same suite on Firefox (WebDriver BiDi)
 *   npm test -- test/core -t "parses"         # files whose path contains test/core, tests whose name matches
 *
 * Browsers are found the way EZTest finds them (EZTEST_CHROMIUM_PATH /
 * EZTEST_FIREFOX_PATH, the `eztest install-browsers` cache, an installed
 * Chrome, Edge or Firefox). On a machine whose browser binaries live
 * elsewhere (EZTEST_TEST_BROWSER_DIRS, colon-separated, or the sandbox
 * defaults below), setup() links them into a temporary folder laid out
 * like the install-browsers cache and points EZTEST_BROWSERS_PATH at it, so
 * the driver picks binaries exactly as an installed EZTest does: the headless
 * shell for headless launches, full Chrome for headed ones.
 *
 * With EZTEST_BROWSER=firefox, imports of src/browser/index.ts resolve to
 * test/support/firefox-as-chromium.ts, whose `chromium` launches Firefox.
 * Tests that only make sense on Chromium (CDP sessions, the CDP screencast,
 * the WebAuthn virtual authenticator) skip themselves, with the reason.
 */
import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Newest `<dir>/<prefix>NNN/chrome-linux/<exe>` in the given folders. */
function newestBuild(dirs, prefix, exe) {
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const builds = readdirSync(dir).filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)));
    builds.sort((x, y) => Number(y.slice(prefix.length)) - Number(x.slice(prefix.length)));
    for (const name of builds) {
      const p = join(dir, name, 'chrome-linux', exe);
      if (isFile(p)) return p;
    }
  }
  return undefined;
}

/** Runs in the runner process before any worker starts; workers inherit process.env. */
function linkBrowsers() {
  const extraDirs = (process.env.EZTEST_TEST_BROWSER_DIRS ?? '').split(':').filter(Boolean);
  const browserDirs = [...extraDirs, '/opt/pw-browsers'];
  if (!process.env.EZTEST_CHROMIUM_PATH && !process.env.EZTEST_BROWSERS_PATH) {
    const full = newestBuild(browserDirs, 'chromium-', 'chrome');
    const shell = newestBuild(browserDirs, 'chromium_headless_shell-', 'headless_shell');
    if (full || shell) {
      // <cache>/chrome-<v>/chrome-linux64/chrome and <cache>/chrome-headless-shell-<v>/chrome-headless-shell-linux64/chrome-headless-shell
      const cache = join(tmpdir(), `eztest-test-browsers-${process.getuid?.() ?? 0}`);
      const link = (target, dir, name) => {
        mkdirSync(join(cache, dir), { recursive: true });
        const at = join(cache, dir, name);
        try {
          if (readlinkSync(at) === target) return;
          rmSync(at, { force: true });
        } catch {
          // not there yet
        }
        symlinkSync(target, at);
      };
      if (full) link(full, join('chrome-0.0.0.1', 'chrome-linux64'), 'chrome');
      if (shell) link(shell, join('chrome-headless-shell-0.0.0.1', 'chrome-headless-shell-linux64'), 'chrome-headless-shell');
      process.env.EZTEST_BROWSERS_PATH = cache;
    }
  }
  if (!process.env.EZTEST_FIREFOX_PATH) {
    for (const dir of [...extraDirs, '/dev/shm/ff157']) {
      const p = [join(dir, 'firefox'), join(dir, 'firefox', 'firefox')].find(isFile);
      if (p) {
        process.env.EZTEST_FIREFOX_PATH = p;
        break;
      }
    }
  }
}

const onFirefox = process.env.EZTEST_BROWSER === 'firefox';
const browserModule = here('./src/browser/index.ts');
const firefoxShim = here('./test/support/firefox-as-chromium.ts');

export default {
  include: ['test/**/*.test.ts'],
  exclude: ['**/node_modules/**'],
  testTimeout: 60_000,
  hookTimeout: 60_000,
  /** Before the workers start (may return a teardown function). */
  globalSetup: linkBrowsers,
  /** Module swaps the loader applies: imports of `from` resolve to `to`, except from the files in `except`. */
  swaps: onFirefox
    ? [
        {
          from: browserModule,
          to: firefoxShim,
          // These test each driver on its own browser, so they keep the real module.
          except: [here('./test/browser/driver.test.ts'), here('./test/browser/firefox-driver.test.ts'), firefoxShim],
        },
      ]
    : [],
};
