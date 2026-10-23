/**
 * Role / accname conformance: every fixture in fixtures/aria-cases.ts must
 * match the spec-derived expectation. Chromium's own accessibility tree
 * (CDP Accessibility.getPartialAXTree) is queried as an oracle and the
 * comparison is reported (not asserted: browsers legitimately differ in
 * places, see each case's `chromium` note).
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, CDPSession, Page } from '../../src/browser/index.js';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { ARIA_CASES, type AriaCase } from './fixtures/aria-cases.js';
import { ev, launch, load } from './harness.js';

interface Got {
  role: string | null;
  name: string;
  desc: string;
  level?: number;
  checked?: boolean | 'mixed';
  pressed?: boolean | 'mixed';
  expanded?: boolean;
  selected?: boolean;
  disabled: boolean;
  foundByRole: boolean;
}

/** Chromium AX role names that differ from the ARIA role names. */
const CHROMIUM_ROLE: Record<string, string | null> = {
  image: 'img',
  RootWebArea: 'document',
  LabelText: null,
  DisclosureTriangle: null,
  ColorWell: null,
  Date: null,
  DateTime: null,
  InputTime: null,
  none: 'none',
  Canvas: null,
  Abbr: null,
  Ruby: null,
  Iframe: null,
  DescriptionList: null,
  ListMarker: null,
  StaticText: null,
  Section: 'region',
  SectionFooter: 'generic',
  SectionHeader: 'generic',
  HeaderAsNonLandmark: 'generic',
  FooterAsNonLandmark: 'generic',
  ContentDeletion: 'deletion',
  ContentInsertion: 'insertion',
  Figcaption: null,
  Legend: null,
  Pre: 'generic',
  Details: 'group',
  'graphics-document': 'img',
  Audio: null,
  Video: null,
};

interface OracleRow {
  id: string;
  field: 'role' | 'name' | 'desc';
  ours: unknown;
  chromium: unknown;
  note?: string;
}

describe('engine conformance: roles and accname 1.2', () => {
  let browser: Browser;
  let page: Page;
  let cdp: CDPSession | undefined;
  // The oracle is Chromium's accessibility tree over CDP; on Firefox (EZTEST_BROWSER=firefox) the
  // spec-derived expectations still run, without the Chromium comparison.
  const onFirefox = process.env.EZTEST_BROWSER === 'firefox';
  const failures: string[] = [];
  const oracle: OracleRow[] = [];
  let oracleCompared = 0;

  beforeAll(async () => {
    browser = await launch();
    page = await browser.newPage();
    if (!onFirefox) {
      cdp = await page.context().newCDPSession(page);
      await cdp.send('Accessibility.enable');
    }
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function chromiumAx(): Promise<{ role: string | null; name: string; desc: string; ignored: boolean } | null> {
    if (!cdp) return null;
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'globalThis.__target' });
    if (!result.objectId) return null;
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false });
    const n = nodes[0] as { ignored: boolean; role?: { value?: string }; name?: { value?: string }; description?: { value?: string } } | undefined;
    if (!n) return null;
    const raw = String(n.role?.value ?? '');
    const role = raw in CHROMIUM_ROLE ? CHROMIUM_ROLE[raw] : raw || null;
    return { role, name: String(n.name?.value ?? ''), desc: String(n.description?.value ?? ''), ignored: n.ignored };
  }

  it(`has at least 150 cases (${ARIA_CASES.length})`, () => {
    expect(ARIA_CASES.length).toBeGreaterThanOrEqual(150);
    expect(new Set(ARIA_CASES.map((c) => c.id)).size).toBe(ARIA_CASES.length);
  });

  it('matches the spec-derived expectations for every case', async () => {
    for (const c of ARIA_CASES) {
      await load(page, c.html, c.setup);
      const got = await ev<Got | null>(
        page,
        `const root = ARG.shadow ? document.querySelector(ARG.shadow).shadowRoot : document;
         const el = root.querySelector(ARG.sel);
         globalThis.__target = el;
         if (!el) return null;
         return { role: E.role(el), name: E.accessibleName(el), desc: E.accessibleDescription(el), level: E.level(el),
           checked: E.checked(el), pressed: E.pressed(el), expanded: E.expanded(el), selected: E.selected(el), disabled: E.disabled(el),
           foundByRole: !E.role(el) || E.query([{ role: E.role(el), includeHidden: true }]).includes(el) };`,
        { sel: c.sel ?? '#t', shadow: c.shadow ?? null },
      );
      if (!got) {
        failures.push(`${c.id}: target not found`);
        continue;
      }
      const check = (field: keyof AriaCase & keyof Got) => {
        if (c[field] === undefined) return;
        if (got[field] !== c[field]) failures.push(`${c.id}: ${field} expected ${JSON.stringify(c[field])}, got ${JSON.stringify(got[field])}`);
      };
      check('role');
      if (!got.foundByRole) failures.push(`${c.id}: a {role: ${JSON.stringify(got.role)}} query does not find the element`);
      check('level');
      check('checked');
      check('pressed');
      check('expanded');
      check('selected');
      check('disabled');
      if (c.name !== undefined && got.name !== c.name) failures.push(`${c.id}: name expected ${JSON.stringify(c.name)}, got ${JSON.stringify(got.name)}`);
      if (c.desc !== undefined && got.desc !== c.desc) failures.push(`${c.id}: desc expected ${JSON.stringify(c.desc)}, got ${JSON.stringify(got.desc)}`);

      // Oracle: Chromium's accessibility tree.
      const ax = await chromiumAx();
      if (!ax) continue;
      oracleCompared++;
      const ourRole = got.role === 'presentation' ? 'none' : got.role;
      const theirRole = ax.ignored ? (ourRole === 'none' || ourRole === null ? ourRole : 'none') : ax.role;
      if (c.role !== undefined && theirRole !== ourRole && !(ax.ignored && (ourRole === 'none' || ourRole === 'generic'))) {
        oracle.push({ id: c.id, field: 'role', ours: got.role, chromium: ax.ignored ? `(ignored) ${ax.role}` : ax.role, note: c.chromium });
      }
      // Chromium sometimes keeps a leading/trailing ASCII space; that is not a difference in the name.
      const ascii = (s: string) => s.replace(/[ \t\n\r\f]+/g, ' ').trim();
      if (c.name !== undefined && !ax.ignored && ascii(ax.name) !== got.name) oracle.push({ id: c.id, field: 'name', ours: got.name, chromium: ax.name, note: c.chromium });
      if (c.desc !== undefined && !ax.ignored && ascii(ax.desc) !== got.desc) oracle.push({ id: c.id, field: 'desc', ours: got.desc, chromium: ax.desc, note: c.chromium });
    }
    const report = {
      cases: ARIA_CASES.length,
      failures,
      passRate: `${(((ARIA_CASES.length - new Set(failures.map((f) => f.split(':')[0])).size) / ARIA_CASES.length) * 100).toFixed(1)}%`,
      oracleCompared,
      oracleMismatches: oracle,
    };
    const out = join(tmpdir(), 'eztest-engine-conformance.json');
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`engine conformance: ${report.cases} cases, pass ${report.passRate}; Chromium AX oracle: ${oracle.length} differences over ${oracleCompared} nodes (report: ${out})`);
    expect(failures).toEqual([]);
  });
});
