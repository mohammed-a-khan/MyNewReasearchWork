/**
 * EZTest depends on no other testing tool: no Playwright, Selenium,
 * Puppeteer, WebdriverIO, Appium, WinAppDriver, Cypress, TestCafe,
 * Nightwatch, Sikuli or axe-core (Deque's accessibility engine), in the manifests, the lockfile, the source, the
 * build output or the published tarball. The browser driver is EZTest's own
 * (src/browser: CDP for Chromium-family browsers, WebDriver BiDi for Firefox),
 * and so is its accessibility engine (src/a11y, written from WCAG 2.2 and WAI-ARIA 1.2).
 *
 * Nor does it integrate with one: product code (the CLI, the config schema,
 * Studio and the rest of src/, the CI integrations, editor extensions,
 * scripts and device agents) names no testing tool it would export to,
 * import from or call: no Pact / Pact Broker, WireMock, Xray, Zephyr,
 * TestRail, qTest, Octane, Mailpit, MailHog, CTRF, Playwright traces,
 * Applitools, Percy, BrowserStack, Sauce Labs, LambdaTest, JMeter, Gatling,
 * ZAP, SoapUI, Allure, ReportPortal and the like. EZTest builds its own
 * (EZTest contracts on the results server, its own mock server, SMTP sink,
 * traces and reports).
 *
 * Reading another tool's *files* to migrate them (the owner-approved
 * migration importers: Cucumber, Selenium and Playwright test files, Postman
 * collections, RSAT, Excel/CSV, OpenAPI) is allowed: those files may name
 * the tools as text, never import them. Every such place is on
 * ALLOWED_MENTIONS / TOOL_ALLOWED with its reason.
 *
 * Nor does EZTest's own test suite use one: its tests run on EZTest's testkit
 * (tools/testkit, written for this repository), so no test runner, assertion,
 * mocking or spying library (vitest, Jest, Mocha, Jasmine, AVA, tap, chai,
 * sinon and the like) is a dependency of any kind, dev dependencies and
 * optional peers included, and no file imports one.
 *
 * The dist/ and tarball checks run when dist/ exists (after `npm run build`).
 * EZTEST_NO_TESTING_TOOLS_REPORT=1 prints the counts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '../support/testkit.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Package names (and scopes) of testing tools. */
const PACKAGE = String.raw`(?:playwright(?:-core|-chromium|-firefox|-webkit)?|@playwright\/[\w.-]+|selenium-webdriver|@seleniumhq\/[\w.-]+|puppeteer(?:-core)?|webdriverio|@wdio\/[\w.-]+|appium(?:-[\w.-]+)?|@appium\/[\w.-]+|cypress|testcafe|nightwatch|winappdriver|sikuli[\w.-]*|axe-core|@axe-core\/[\w.-]+)`;
/** An import of one: `from '<pkg>'`, `import '<pkg>'`, `import('<pkg>')`, `require('<pkg>')`, subpaths included. */
const IMPORT_RE = new RegExp(String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"\`])(${PACKAGE})(?:\/[^'"\`]*)?\1`, 'g');
/** Names that only ever mean a testing tool (plain "playwright" also names a migration source format, see the importers). */
const MENTION_RE = /playwright-core|@playwright\/|selenium-webdriver|puppeteer|webdriverio|@wdio\/|@appium\/|\bappium\b|\bcypress\b|testcafe|nightwatch|winappdriver|sikuli|axe-core|@axe-core\//gi;
/** Testing-tool names in package.json / package-lock.json (as package names). */
const MANIFEST_NAMES = ['playwright', 'playwright-core', '@playwright/', 'selenium-webdriver', 'puppeteer', 'webdriverio', '@wdio/', 'appium', 'cypress', 'testcafe', 'nightwatch', 'winappdriver', 'sikuli', 'axe-core', '@axe-core/'];

/** Paths (prefixes, relative to the package root) that may name testing tools as text, and why. */
const ALLOWED_MENTIONS: Array<{ prefix: string; reason: string }> = [
  { prefix: 'src/importers/', reason: "migration importers (owner-approved): they read Playwright / Selenium / Cucumber test files to migrate them, match those tools' module names as text and import nothing from them" },
  { prefix: 'dist/importers/', reason: 'build output of src/importers (same reason)' },
];

/**
 * Testing tools (and their file formats) that product code must not name: anything EZTest
 * would export to, import from, call or depend on. "playwright" and "selenium" alone are
 * covered by MENTION_RE above (their package names) and by the importers' allowlist.
 */
export const TOOL_RE = new RegExp(
  [
    String.raw`\bpact(?:s|flow)?\b`, String.raw`pact[-_ ]?broker`, 'can-i-deploy', 'wiremock', String.raw`\bxray\b`, 'zephyr', 'testrail', String.raw`\bqtest\b`, String.raw`\boctane\b`,
    'mailpit', 'mailhog', String.raw`\bctrf\b`, 'importPlaywrightTrace', String.raw`playwright[- ]trace`, 'applitools', String.raw`\bpercy\b`, 'storybook', String.raw`selenium[- ]grid`,
    'browserstack', String.raw`sauce ?labs`, 'lambdatest', 'perfecto', 'jmeter', 'gatling', String.raw`\bzap\b`, 'soapui', 'readyapi', String.raw`\ballure\b`, 'reportportal',
    'postman', String.raw`\bk6\b`, String.raw`\bprism\b`, 'easyrepro', 'katalon', 'testcomplete', 'ranorex', String.raw`\btosca\b`, 'newman', 'hoverfly', 'mountebank',
    'axe-core', String.raw`\baxe\b`, 'dequeuniversity', String.raw`\bdeque\b`, 'pa11y', 'lighthouse', String.raw`\bwave\s+(?:api|evaluation)`,
    // Playwright's trace layout (EZTest's browser trace is its own format: src/browser/trace-format.ts).
    'context-options', '__playwright', 'frame-snapshot', 'resource-snapshot', 'screencast-frame', String.raw`trace\.trace\b`, String.raw`trace\.network\b`, String.raw`trace\.playwright\b`,
  ].join('|'),
  'gi',
);
/** Directories of product code for the tool-name scan (tests and docs may name tools, e.g. to say they are not supported). */
const PRODUCT_DIRS = ['src', 'integrations', 'editors', 'scripts', 'agents'];
/** Product-code places that may name a tool from TOOL_RE, and why (optionally only on lines matching `line`). */
const TOOL_ALLOWED: Array<{ prefix: string; line?: RegExp; reason: string }> = [
  { prefix: 'src/importers/', reason: 'migration importers (owner-approved): Cucumber, Selenium and Playwright test files, Postman collections, RSAT, Excel/CSV, OpenAPI; inbound file reading only' },
  { prefix: 'src/cli/program.ts', line: /postman/i, reason: 'the `eztest import` command of the migration importers (owner-approved): Postman collections and environments' },
  { prefix: 'src/studio/client/pages/import.ts', reason: "Studio's import page for the migration importers (owner-approved)" },
  { prefix: 'src/config/removed.ts', reason: 'recognises configuration keys of the removed integrations (Pact, Mailpit/MailHog, CTRF, test-management publishers, trace.playwright) only to warn with a migration hint; it integrates with nothing' },
];

export interface ToolScanResult {
  files: number;
  mentions: string[];
  allowed: Array<{ where: string; reason: string }>;
}

/** Names of testing tools in product code (allowed only on TOOL_ALLOWED). */
export function scanToolNames(files: string[]): ToolScanResult {
  const r: ToolScanResult = { files: files.length, mentions: [], allowed: [] };
  for (const file of files) {
    const path = rel(file);
    const text = readFileSync(file, 'utf8');
    TOOL_RE.lastIndex = 0;
    if (!TOOL_RE.test(text)) continue;
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(TOOL_RE)) {
        const where = `${path}:${i + 1}: ${m[0]}`;
        const ok = TOOL_ALLOWED.find((a) => path.startsWith(a.prefix) && (!a.line || a.line.test(line)));
        if (ok) r.allowed.push({ where, reason: ok.reason });
        else r.mentions.push(where);
      }
    });
  }
  return r;
}

/**
 * Test runners and assertion / mocking / spying / coverage libraries (EZTest's own tests run on tools/testkit).
 * Exact names, or `prefix*` for a family; `@types/<name>` of each is covered too.
 */
const RUNNER_NAMES = [
  'vitest', 'vitest-*', '@vitest/*', 'vite-node', 'jest', 'jest-*', '@jest/*', 'ts-jest', 'babel-jest', 'mocha', 'mocha-*', '@mochajs/*', 'jasmine', 'jasmine-*',
  'karma', 'karma-*', 'ava', '@ava/*', 'tap', '@tapjs/*', 'tape', 'uvu', 'node-tap', '@hapi/lab', 'qunit', 'chai', 'chai-*', '@chaijs/*', 'sinon', 'sinon-*', '@sinonjs/*',
  'tinyspy', 'expect', 'expect-type', 'should', 'power-assert', 'testdouble', 'unexpected', '@testing-library/*', 'nock', 'msw', 'supertest', 'c8', 'nyc', 'istanbul',
  'istanbul-*', '@istanbuljs/*', 'ts-mocha', 'esmock', 'proxyquire', 'quibble', 'mock-fs', 'tinybench',
];

export function isTestRunnerPackage(name: string): boolean {
  const n = name.startsWith('@types/') ? name.slice(7).replace(/^([^_]+)__(.+)$/, '@$1/$2') : name;
  return RUNNER_NAMES.some((p) => (p.endsWith('*') ? n.startsWith(p.slice(0, -1)) : n === p));
}

/** An import of a package (bare specifier, subpaths included): `from '<pkg>'`, `import('<pkg>')`, `require('<pkg>')`, `import '<pkg>'`. */
const PACKAGE_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])((?:@[\w.-]+\/)?[\w.-]+)(?:\/[^'"`]*)?\1/g;

const SOURCE_DIRS = ['src', 'scripts', 'agents', 'integrations', 'examples', 'editors'];
/** Everything that could import a test runner: the product, its tools and EZTest's own tests. */
const TEST_RUNNER_SCAN_DIRS = [...SOURCE_DIRS, 'test', 'tools'];
const TEXT_EXT = /\.(?:[cm]?[jt]sx?|json|ya?ml|html|css|md|ps1|sh|py|xml|txt)$/i;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (TEXT_EXT.test(name) && st.size < 8_000_000) out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(ROOT, p).split(sep).join('/');
const allowedMention = (path: string) => ALLOWED_MENTIONS.find((a) => path.startsWith(a.prefix));

export interface ScanResult {
  files: number;
  imports: string[];
  mentions: string[];
  allowed: Array<{ where: string; reason: string }>;
}

/** Imports of testing tools (never allowed) and mentions of them (allowed only on ALLOWED_MENTIONS). */
export function scanFiles(files: string[]): ScanResult {
  const r: ScanResult = { files: files.length, imports: [], mentions: [], allowed: [] };
  for (const file of files) {
    const path = rel(file);
    const text = readFileSync(file, 'utf8');
    if (!/playwright|selenium|puppeteer|webdriverio|wdio|appium|cypress|testcafe|nightwatch|winappdriver|sikuli|axe-core/i.test(text)) continue;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const where = `${path}:${i + 1}`;
      for (const m of line.matchAll(IMPORT_RE)) r.imports.push(`${where}: ${m[0]}`);
      for (const m of line.matchAll(MENTION_RE)) {
        const ok = allowedMention(path);
        if (ok) r.allowed.push({ where: `${where}: ${m[0]}`, reason: ok.reason });
        else r.mentions.push(`${where}: ${m[0]}`);
      }
    });
  }
  return r;
}

function report(label: string, r: ScanResult): void {
  if (!process.env.EZTEST_NO_TESTING_TOOLS_REPORT) return;
  console.log(`[no-testing-tools] ${label}: ${r.files} files, ${r.imports.length} imports, ${r.mentions.length} disallowed mentions, ${r.allowed.length} allowlisted mentions`);
  for (const a of r.allowed) console.log(`  allowed ${a.where}  (${a.reason})`);
}

const isTool = (name: string) => MANIFEST_NAMES.some((n) => (n.endsWith('/') ? name.startsWith(n) : name === n || name.startsWith(`${n}-`)));

describe('no other testing tool', () => {
  it('package.json names none (dependencies of any kind, overrides, keywords)', () => {
    const text = readFileSync(join(ROOT, 'package.json'), 'utf8').toLowerCase();
    const found = MANIFEST_NAMES.filter((n) => text.includes(n));
    expect(found).toEqual([]);
    const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'bundleDependencies']) {
      expect(Object.keys(pkg[field] ?? {}).filter(isTool), field).toEqual([]);
    }
  });

  it('package-lock.json installs none and depends on none', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, Record<string, unknown>> };
    const installed = Object.keys(lock.packages).filter((k) => k && isTool(k.slice(k.lastIndexOf('node_modules/') + 'node_modules/'.length)));
    expect(installed).toEqual([]);
    const deps: string[] = [];
    for (const [key, p] of Object.entries(lock.packages)) {
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
        for (const name of Object.keys((p[field] as Record<string, unknown> | undefined) ?? {})) {
          if (isTool(name) || MANIFEST_NAMES.some((n) => name.includes(n))) deps.push(`${key || '(root)'} ${field} ${name}`);
        }
      }
    }
    // No allowlist: not even an optional peer of a dev dependency may name a testing tool.
    expect(deps).toEqual([]);
    if (process.env.EZTEST_NO_TESTING_TOOLS_REPORT) console.log(`[no-testing-tools] package-lock.json: ${Object.keys(lock.packages).length} packages, 0 testing tools installed or depended on`);
  });

  it('package.json names no test runner, assertion, mocking or coverage library (dev dependencies and optional peers included)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
    const found: string[] = [];
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'overrides', 'bundleDependencies', 'bundledDependencies']) {
      const v = pkg[field];
      const names = Array.isArray(v) ? (v as string[]) : Object.keys((v as Record<string, unknown> | undefined) ?? {});
      for (const name of names) if (isTestRunnerPackage(name)) found.push(`${field} ${name}`);
    }
    expect(found).toEqual([]);
    // Nor does an npm script call one.
    const scripts = Object.entries((pkg.scripts as Record<string, string> | undefined) ?? {}).filter(([, cmd]) => cmd.split(/[\s;&|()=]+/).some(isTestRunnerPackage));
    expect(scripts).toEqual([]);
  });

  it('package-lock.json installs no test runner, assertion, mocking or coverage library, and nothing depends on one (optional peers included)', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, Record<string, unknown>> };
    const installed = Object.keys(lock.packages).filter((k) => k && isTestRunnerPackage(k.slice(k.lastIndexOf('node_modules/') + 'node_modules/'.length)));
    expect(installed).toEqual([]);
    const deps: string[] = [];
    for (const [key, p] of Object.entries(lock.packages)) {
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
        for (const name of Object.keys((p[field] as Record<string, unknown> | undefined) ?? {})) if (isTestRunnerPackage(name)) deps.push(`${key || '(root)'} ${field} ${name}`);
      }
    }
    expect(deps).toEqual([]);
  });

  it('no test, tool or source file imports a test runner or assertion library', () => {
    const top = readdirSync(ROOT).filter((n) => /\.[cm]?[jt]s$/.test(n)).map((n) => join(ROOT, n));
    // This file is left out: it spells those imports as the scanner's own test cases.
    const files = [...TEST_RUNNER_SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))), ...top].filter((f) => /\.[cm]?[jt]sx?$/.test(f) && rel(f) !== 'test/legal/no-testing-tools.test.ts');
    expect(files.length).toBeGreaterThan(800);
    const imports: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(PACKAGE_IMPORT_RE)) if (isTestRunnerPackage(m[2])) imports.push(`${rel(file)}: ${m[0]}`);
    }
    expect(imports).toEqual([]);
  });

  it("EZTest's own test runner (tools/testkit) is a development tool: not in the package files, not compiled to dist/", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files: string[]; scripts: Record<string, string> };
    expect(pkg.files.filter((f) => f.startsWith('tools') || f.includes('testkit'))).toEqual([]);
    const build = JSON.parse(readFileSync(join(ROOT, 'tsconfig.build.json'), 'utf8')) as { include: string[] };
    expect(build.include).toEqual(['src/**/*.ts']);
    expect(pkg.scripts.test).toBe('node tools/testkit/cli.mjs');
  });

  it('the test-runner check catches each family and spares lookalikes', () => {
    for (const n of ['vitest', '@vitest/expect', 'vite-node', 'jest', 'jest-circus', '@jest/globals', '@types/jest', 'mocha', '@types/mocha', 'jasmine-core', 'ava', 'tap', '@tapjs/core', 'tape', 'chai', 'chai-as-promised', '@types/chai', 'sinon', '@sinonjs/fake-timers', 'tinyspy', 'expect', 'uvu', 'c8', 'nyc', '@testing-library/dom', '@types/testing-library__jest-dom']) {
      expect(isTestRunnerPackage(n), n).toBe(true);
    }
    for (const n of ['vite', 'esbuild', 'tapable', 'avatar', 'chaikin', 'expect-ct', 'tinypool', 'jestful', 'typescript', '@types/node', 'mochawesome']) {
      expect(isTestRunnerPackage(n), n).toBe(false);
    }
    const src = "import { it } from 'vitest';\nconst { expect } = require('chai');\nawait import('@jest/globals/x');\nimport y from './vitest.js';\nimport 'sinon';";
    expect([...src.matchAll(PACKAGE_IMPORT_RE)].map((m) => m[2]).filter(isTestRunnerPackage)).toEqual(['vitest', 'chai', '@jest/globals', 'sinon']);
  });

  it('the source imports none', () => {
    const r = scanFiles(SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d))));
    report('source', r);
    expect(r.files).toBeGreaterThan(500);
    expect(r.imports).toEqual([]);
    expect(r.mentions).toEqual([]);
  });

  it('product code names no testing tool it would export to, import from, call or depend on', () => {
    const r = scanToolNames(PRODUCT_DIRS.flatMap((d) => walk(join(ROOT, d))));
    if (process.env.EZTEST_NO_TESTING_TOOLS_REPORT) {
      console.log(`[no-testing-tools] product code: ${r.files} files, ${r.mentions.length} disallowed tool names, ${r.allowed.length} allowlisted`);
      for (const a of r.allowed) console.log(`  allowed ${a.where}  (${a.reason})`);
    }
    expect(r.files).toBeGreaterThan(500);
    expect(r.mentions).toEqual([]);
  });

  it('package.json and the lockfile name none of those tools', () => {
    const re = /pact-foundation|\bpact\b|wiremock|mailpit|mailhog|allure|applitools|@percy\/|browserstack|saucelabs|lambdatest|newman|postman|ctrf|jmeter|gatling|reportportal|storybook|xray|testrail|zephyr|qtest|octane|axe-core|@axe-core\/|pa11y|lighthouse/i;
    const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8');
    expect(pkg.match(re)).toBeNull();
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, unknown> };
    expect(Object.keys(lock.packages).filter((k) => re.test(k.slice(k.lastIndexOf('node_modules/') + 'node_modules/'.length)))).toEqual([]);
  });

  it('the tool-name scanner catches each removed integration and spares lookalikes', () => {
    const hits = (t: string) => [...t.matchAll(TOOL_RE)].map((m) => m[0].toLowerCase());
    expect(hits('PactBrokerClient; readPactFile; "Start a pact"; pacts/; can-i-deploy')).toEqual(['pactbroker', 'pact', 'pacts', 'can-i-deploy']);
    expect(hits("toWireMock(); use: 'xray'; zephyr; testrail; qTest; ALM Octane; MailpitProvider; MailHog; ctrf-report.json; importPlaywrightTrace")).toEqual(['wiremock', 'xray', 'zephyr', 'testrail', 'qtest', 'octane', 'mailpit', 'mailhog', 'ctrf', 'importplaywrighttrace']);
    expect(hits('Applitools Eyes, Percy, BrowserStack, Sauce Labs, LambdaTest, JMeter, Gatling, OWASP ZAP, SoapUI, Allure, ReportPortal, Postman, k6')).toHaveLength(13);
    expect(hits('impact, impacts, compact, Zapier, allurement, k64, prismatic, contracts, EZTest contract')).toEqual([]);
    expect(hits("import axe from 'axe-core'; window.axe.run(); https://dequeuniversity.com/rules/axe/; Deque; pa11y; Lighthouse")).toEqual(['axe', 'axe-core', 'axe', 'dequeuniversity', 'axe', 'deque', 'pa11y', 'lighthouse']);
    expect(hits('maxEntries, taxes, relaxed, FilterSyntaxError, a11y, EZTest accessibility engine')).toEqual([]);
    expect(hits("{ type: 'context-options' }, attrs.__playwright_value_, 'frame-snapshot', 'resource-snapshot', 'screencast-frame', trace.trace, trace.network, trace.playwright")).toHaveLength(8);
    expect(hits('actions.jsonl, network.jsonl, eztest-browser-trace, trace.browser, trace.timeTravel')).toEqual([]);
  });

  it('the scanner catches every import form', () => {
    const forms = [
      "import { chromium } from 'playwright-core';",
      'import type { Page } from "@playwright/test";',
      "const { Builder } = require('selenium-webdriver');",
      "await import('puppeteer');",
      "import 'webdriverio';",
      "import x from '@wdio/globals';",
      "export * from 'appium/driver';",
      "import c from 'cypress';",
      "const axe = require('axe-core');",
      "import { AxeBuilder } from '@axe-core/playwright';",
    ];
    for (const f of forms) expect([...f.matchAll(IMPORT_RE)], f).toHaveLength(1);
    expect([..."import { x } from './playwright.js';".matchAll(IMPORT_RE)]).toHaveLength(0);
    expect([..."import { importPlaywrightTrace } from '../runner/trace/index.js';".matchAll(IMPORT_RE)]).toHaveLength(0);
  });

  it.skipIf(!existsSync(join(ROOT, 'dist')))('the build output (dist/) imports none', () => {
    const r = scanFiles(walk(join(ROOT, 'dist')));
    report('dist', r);
    expect(r.files).toBeGreaterThan(500);
    expect(r.imports).toEqual([]);
    expect(r.mentions).toEqual([]);
  });

  it.skipIf(!existsSync(join(ROOT, 'dist')))('the published tarball contains no testing-tool code', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const files = (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0].files.map((f) => f.path);
    expect(files.length).toBeGreaterThan(500);
    expect(files.filter((f) => f.includes('node_modules/') || isTool(f.split('/')[0]))).toEqual([]);
    const code = files.filter((f) => /\.(?:[cm]?js|d\.ts)$/.test(f)).map((f) => join(ROOT, f));
    const r = scanFiles(code);
    report('tarball (code files)', r);
    expect(r.imports).toEqual([]);
    expect(r.mentions).toEqual([]);
  }, 120_000);
});
