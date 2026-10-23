import { describe, expect, it } from '../support/testkit.js';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJourneyFile, parseEzScript } from '../../src/intent/index.js';
import { coverageEquivalence, detectImportKind, importFiles, importReportMarkdown, writeImported } from '../../src/importers/index.js';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));

describe('importFiles / writeImported', () => {
  it('detects formats by extension and content', () => {
    expect(detectImportKind('a.feature')).toBe('gherkin');
    expect(detectImportKind('a.spec.ts', "import { test } from '@playwright/test'")).toBe('playwright');
    expect(detectImportKind('util.ts', 'export const x = 1')).toBeUndefined();
    expect(detectImportKind('T.java')).toBe('selenium');
    expect(detectImportKind('t.py', 'import os')).toBeUndefined();
    expect(detectImportKind('t.py', 'from selenium import webdriver')).toBe('selenium');
    expect(detectImportKind('cases.csv')).toBe('manual-csv');
    expect(detectImportKind('cases.xlsx')).toBe('manual-xlsx');
    expect(detectImportKind('rec.xml', '<Recording><Node/></Recording>')).toBe('task-recorder');
    expect(detectImportKind('pom.xml', '<project></project>')).toBeUndefined();
  });

  it('imports a whole directory of mixed formats with unique journey ids and an honest report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-import-dir-'));
    for (const f of ['bob-order.feature', 'bob-order.spec.js', 'LoginTest.java', 'test_checkout.py', 'SearchTests.cs', 'manual-tests.csv', 'create-sales-order.xml']) {
      await writeFile(join(dir, f), await readFile(join(FIX, f)));
    }
    await writeFile(join(dir, 'helpers.ts'), 'export const x = 1;\n');
    const report = await importFiles([dir, join(FIX, 'bob-order.feature')], { cwd: dir, tags: ['migrated'] });
    expect(report.files).toEqual([
      'LoginTest.java', 'SearchTests.cs', 'bob-order.feature', 'bob-order.spec.js', 'create-sales-order.xml', 'helpers.ts', 'manual-tests.csv', 'test_checkout.py',
      join(FIX, 'bob-order.feature'),
    ]);
    expect(report.warnings).toContain('helpers.ts: format not recognised; skipped');
    const kinds = new Set(report.converted.map((c) => c.kind));
    expect([...kinds].sort()).toEqual(['gherkin', 'manual-csv', 'playwright', 'selenium', 'task-recorder']);
    const ids = report.converted.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('ez-shop-orders-bob-orders-2-x-gadget-49-50-2'); // the same feature imported twice
    expect(report.journeys.every((j) => j.tags.includes('migrated'))).toBe(true);
    const sum = report.converted.reduce((n, c) => n + c.coverage.sourceSteps, 0);
    expect(report.coverage.sourceSteps).toBe(sum);
    expect(report.todo.length).toBe(report.converted.reduce((n, c) => n + c.todo.length, 0));

    const out = join(dir, 'journeys');
    const w = await writeImported(report, out);
    expect(w.ezFiles).toHaveLength(report.journeys.length);
    expect(w.unconvertedFiles.map((f) => f.replace(/^.*[\\/]/, ''))).toEqual(['tc-003.unconverted.txt']);
    expect(await readFile(w.unconvertedFiles[0], 'utf8')).toContain('# TODO (not converted): Do the thing');
    // every written .ez loads back with the standard journey loader
    for (const f of w.ezFiles) {
      const j = await loadJourneyFile(f);
      expect(report.journeys.find((x) => x.id === j.id)).toEqual(j);
    }
    const json = JSON.parse(await readFile(w.reportJson, 'utf8'));
    expect(json.coverage).toEqual(report.coverage);
    expect(json.todo).toHaveLength(report.todo.length);
    expect(json.journeys.every((j: { verified: boolean }) => j.verified === false)).toBe(true);
    expect(json.equivalence.journeys.every((j: { status: string }) => j.status === 'not-run' || j.status === 'not-converted')).toBe(true);
    const md = await readFile(w.reportMd, 'utf8');
    expect(md).toContain('Not verified: run with --verify');
    expect(md).toContain('## Not converted (TODO)');
    expect(md).toContain('| LoginTest.java:39 | `customer.selectByIndex(2)` | Select.selectByIndex is not converted |');
    expect((await readdir(out)).filter((f) => f.endsWith('.ez')).length).toBe(report.journeys.length);
  });

  it('coverageEquivalence without a run never claims verification', async () => {
    const report = await importFiles([join(FIX, 'SearchTests.cs')]);
    const eq = coverageEquivalence(report);
    expect(eq.journeys).toEqual([expect.objectContaining({ status: 'not-run', verifiedSteps: 0, verifiedAssertions: 0, convertedSteps: 7 })]);
    expect(eq.ratios).toEqual({ converted: 1, verified: 0 });
    expect(eq.needsWork[0]).toMatch(/converted but not verified/);
    expect(importReportMarkdown(report)).toContain('| sign in shows dashboard (`sign-in-shows-dashboard`) | ');
    expect(parseEzScript(report.converted[0].ez).steps).toHaveLength(7);
  });

  it('rejects an empty selection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-import-empty-'));
    await expect(importFiles([dir])).rejects.toThrow(/no files/);
  });
});
