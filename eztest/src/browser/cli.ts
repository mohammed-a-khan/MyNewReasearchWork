/** `eztest install-browsers`: provision browsers for the EZTest driver. */
import type { Command } from 'commander';
import { browserCacheDir, cachedBuilds, channelCandidates } from './launcher/find.js';
import { installBrowser } from './launcher/install.js';
import { installFirefox } from './firefox/install.js';
import { cachedFirefoxBuilds } from './firefox/launch.js';
import { existsSync } from 'node:fs';

export interface BrowserCliIO {
  out(s: string): void;
  err(s: string): void;
}

export function registerBrowserCommands(program: Command, io: BrowserCliIO): void {
  program
    .command('install-browsers')
    .description('download Chrome for Testing or Firefox into the EZTest browser cache (or check an installed Chrome / Edge)')
    .argument('[browser]', 'chromium | chrome | chrome-headless-shell | firefox | firefox-esr | msedge-check | chrome-check, optionally with @<version> (e.g. chromium@141.0.7390.54, firefox@140.4.0esr)', 'chromium')
    .option('--browser-version <version>', 'exact Chrome for Testing version (e.g. 141.0.7390.54); default: latest Stable from the version index (--version is taken by the CLI itself)')
    .option('--channel <channel>', 'Stable | Beta | Dev | Canary (with the version index)', 'Stable')
    .option('--versions-url <url>', 'version index URL (env EZTEST_CFT_VERSIONS_URL)')
    .option('--download-base <url>', 'download base URL / mirror (env EZTEST_CFT_DOWNLOAD_BASE; Firefox: EZTEST_FIREFOX_DOWNLOAD_BASE)')
    .option('--locale <locale>', 'Firefox build locale', 'en-US')
    .option('--sha256 <hex>', 'expected SHA-256 of the archive')
    .option('--insecure-skip-checksum', 'install even when no checksum can be verified')
    .option('--path <dir>', 'install directory (default: the EZTest browser cache, env EZTEST_BROWSERS_PATH)')
    .option('--force', 're-download even when installed')
    .option('--list', 'list installed builds')
    .action(async (browser: string, o: { browserVersion?: string; channel?: string; versionsUrl?: string; downloadBase?: string; locale?: string; sha256?: string; insecureSkipChecksum?: boolean; path?: string; force?: boolean; list?: boolean }) => {
      const at = browser.indexOf('@');
      const version = at > 0 ? browser.slice(at + 1) : o.browserVersion;
      if (at > 0) browser = browser.slice(0, at);
      if (o.list) {
        const dir = o.path ?? browserCacheDir();
        io.out(`browser cache: ${dir}`);
        for (const k of ['chrome', 'chrome-headless-shell'] as const) for (const b of cachedBuilds(k, dir)) io.out(`  ${k} ${b.version}  ${b.executablePath}`);
        for (const b of cachedFirefoxBuilds(dir)) io.out(`  firefox ${b.version}  ${b.executablePath}`);
        return;
      }
      if (browser === 'firefox' || browser === 'firefox-esr') {
        try {
          const r = await installFirefox({
            version,
            esr: browser === 'firefox-esr',
            locale: o.locale,
            downloadBase: o.downloadBase,
            insecureSkipChecksum: o.insecureSkipChecksum,
            dir: o.path,
            force: o.force,
            log: (l) => io.out(l),
          });
          io.out(`${r.alreadyInstalled ? 'already installed' : 'installed'}: firefox ${r.version}\n  ${r.executablePath}`);
        } catch (e) {
          io.err(`install-browsers failed: ${(e as Error).message}`);
          process.exitCode = 1;
        }
        return;
      }
      if (browser === 'msedge-check' || browser === 'chrome-check') {
        const channel = browser === 'msedge-check' ? 'msedge' : 'chrome';
        const hit = channelCandidates(channel).find((p) => existsSync(p));
        if (hit) io.out(`${channel}: installed at ${hit}`);
        else {
          io.out(`${channel}: not installed (looked in ${channelCandidates(channel).join(', ') || 'no standard location on this platform'})`);
          io.out(channel === 'msedge' ? 'Install Microsoft Edge from https://www.microsoft.com/edge, then use channel: msedge.' : 'Install Google Chrome, or run "eztest install-browsers chromium".');
          process.exitCode = 1;
        }
        return;
      }
      if (!['chromium', 'chrome', 'chrome-headless-shell'].includes(browser)) {
        io.err(`Unknown browser "${browser}" (chromium, chrome, chrome-headless-shell, firefox, firefox-esr, msedge-check, chrome-check). WebKit is not supported.`);
        process.exitCode = 2;
        return;
      }
      try {
        const r = await installBrowser({
          kind: browser === 'chrome-headless-shell' ? 'chrome-headless-shell' : 'chrome',
          version,
          channel: o.channel as 'Stable',
          versionsUrl: o.versionsUrl,
          downloadBase: o.downloadBase,
          sha256: o.sha256,
          insecureSkipChecksum: o.insecureSkipChecksum,
          dir: o.path,
          force: o.force,
          log: (l) => io.out(l),
        });
        io.out(`${r.alreadyInstalled ? 'already installed' : 'installed'}: ${browser} ${r.version}\n  ${r.executablePath}`);
      } catch (e) {
        io.err(`install-browsers failed: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
