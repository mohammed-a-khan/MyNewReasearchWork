/**
 * Things that take over a real site's page in front of the app: Google's full-screen "vignette" ad (shown after a
 * click on a link, with the page's address ending in #google_vignette, until someone closes it), and Google's
 * consent dialog (Funding Choices). A person closes them and carries on; so does EZTest, before an action and while
 * it waits for expectations, and says so in the log. Nothing else is touched: an app's own dialogs and banners are
 * part of what is tested.
 */
import type { Page } from '../../browser/index.js';
import type { Logger } from '../../core/index.js';
import { sleep } from '../../core/index.js';

interface Seen {
  vignette: boolean;
  consent: boolean;
}

/** A cheap look at the page: is something of the kind above in front of it? */
async function look(page: Page): Promise<Seen | undefined> {
  return page
    .evaluate(() => {
      const big = (el: Element | null) => {
        if (!el) return false;
        const r = (el as HTMLElement).getBoundingClientRect();
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width >= innerWidth * 0.5 && r.height >= innerHeight * 0.5;
      };
      const vignette = Array.from(document.querySelectorAll('ins.adsbygoogle[data-vignette-loaded="true"]')).some(big) ||
        (location.hash === '#google_vignette' && Array.from(document.querySelectorAll('ins.adsbygoogle')).some(big));
      const consent = big(document.querySelector('.fc-consent-root .fc-dialog-container')) || big(document.querySelector('.fc-consent-root'));
      return { vignette, consent };
    })
    .catch(() => undefined);
}

/**
 * Close a Google vignette ad or consent dialog in front of the page. Returns what was closed (for the log), or
 * undefined when there was nothing to close (the usual case, one quick evaluate).
 */
export async function dismissInterstitials(page: Page, logger?: Logger): Promise<string | undefined> {
  if (page.isClosed()) return undefined;
  const seen = await look(page);
  if (!seen || (!seen.vignette && !seen.consent)) return undefined;
  let closed: string | undefined;
  if (seen.vignette) {
    // The close button sits in one of the ad's frames ("Close ad").
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const button = frame.locator('#dismiss-button');
      if ((await button.count().catch(() => 0)) !== 1) continue;
      const ok = await button.click({ timeout: 3000 }).then(() => true).catch(async () =>
        frame.evaluate(() => {
          const b = document.querySelector('#dismiss-button') as HTMLElement | null;
          b?.click();
          return !!b;
        }).catch(() => false));
      if (ok) {
        closed = 'a full-screen Google ad (vignette)';
        break;
      }
    }
  }
  if (seen.consent) {
    const consent = page.locator('.fc-consent-root button.fc-cta-consent, .fc-consent-root button.fc-primary-button').first();
    if (await consent.click({ timeout: 3000 }).then(() => true).catch(() => false)) closed = closed ? `${closed} and a consent dialog` : 'a consent dialog (Google Funding Choices)';
  }
  if (!closed) {
    logger?.warn(`a full-screen ad or consent dialog covers the page and has no close button EZTest can reach (frames: ${page.frames().map((f) => f.url().slice(0, 80)).join(', ')})`);
    return undefined;
  }
  for (let i = 0; i < 20; i++) {
    const now = await look(page);
    if (!now || (!now.vignette && !now.consent)) break;
    await sleep(150);
  }
  logger?.warn(`closed ${closed} that covered the page`);
  return closed;
}
