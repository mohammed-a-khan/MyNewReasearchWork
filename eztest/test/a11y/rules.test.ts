/**
 * Every rule of EZTest's accessibility engine against its own fixture
 * pages: the failing variant produces a violation (or needs review), the
 * passing variant produces neither. Each scan runs only the rule under test.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { RULES, scanAccessibility } from '../../src/a11y/index.js';
import { FIXTURES, page as wrap, type RuleFixture } from './fixtures.js';

let browser: Browser;
let pg: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  pg = await browser.newPage({ viewport: { width: 1000, height: 700 } });
});
afterAll(async () => {
  await browser?.close();
});

async function scan(f: RuleFixture, html: string) {
  await pg.setContent(f.doc ? html : wrap(html));
  return scanAccessibility(pg, { rules: [f.rule], dynamic: true });
}

describe('accessibility rule fixtures', () => {
  it('cover every rule with a failing or needs-review variant', () => {
    const covered = new Set(FIXTURES.filter((f) => f.fail || f.review).map((f) => f.rule));
    expect(RULES.map((r) => r.id).filter((id) => !covered.has(id))).toEqual([]);
    expect(FIXTURES.filter((f) => !f.pass).map((f) => f.rule)).toEqual(['media.audio-alternative', 'motion.blink', 'motion.marquee']);
  });

  for (const f of FIXTURES) {
    it(`${f.rule}`, async () => {
      if (f.fail) {
        const r = await scan(f, f.fail);
        const v = r.violations.find((x) => x.ruleId === f.rule);
        expect(v, `${f.rule} should fail`).toBeDefined();
        expect(v!.nodeCount).toBeGreaterThan(0);
        expect(v!.nodes[0].target.length).toBeGreaterThan(0);
        expect(v!.nodes[0].failureSummary?.length).toBeGreaterThan(10);
        expect(v!.nodes[0].html).toMatch(/^</);
        expect(v!.sc.length).toBeGreaterThan(0);
        expect(v!.helpUrl).toMatch(/^https:\/\/(?:www\.w3\.org|html\.spec\.whatwg\.org)\//);
      }
      if (f.review) {
        const r = await scan(f, f.review);
        expect(r.needsReview.find((x) => x.ruleId === f.rule), `${f.rule} should need review`).toBeDefined();
        expect(r.violations.find((x) => x.ruleId === f.rule)).toBeUndefined();
      }
      if (f.pass) {
        const r = await scan(f, f.pass);
        const bad = [...r.violations, ...r.needsReview].filter((x) => x.ruleId === f.rule);
        expect(bad.map((b) => `${b.outcome}: ${b.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary}`).join('; ')}`)).toEqual([]);
        expect(r.passes, `${f.rule} should report a pass`).toBe(1);
      }
    });
  }
});
