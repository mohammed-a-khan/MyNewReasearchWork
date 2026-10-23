/** Every phrasing in the Components section of docs/ez-language.md parses to a component step, and the counts are right. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from '../support/testkit.js';
import { Step } from '../../src/core/index.js';
import { COMPONENT_RULES, INTENT_RULES, parseIntent } from '../../src/intent/index.js';

const doc = readFileSync(new URL('../../docs/ez-language.md', import.meta.url), 'utf8');
const start = doc.indexOf('## Components (');
const section = doc.slice(start, doc.indexOf('\n## ', start + 5));

function tableSnippets(part: string): string[] {
  const out: string[] = [];
  for (const line of part.split('\n')) {
    if (!line.startsWith('|') || /^\|\s*-/.test(line) || /^\| Purpose \|/.test(line)) continue;
    const cells = line.split(/(?<!\\)\|/).slice(2).join('|');
    for (const m of cells.matchAll(/`([^`]+)`/g)) out.push(m[1]);
  }
  return out;
}

describe('docs: Components section', () => {
  const snippets = tableSnippets(section);

  it('documents the phrasing counts', () => {
    expect(start).toBeGreaterThan(0);
    expect(section).toContain(`## Components (${COMPONENT_RULES.length} phrasings)`);
    expect(doc).toContain(`## Actions (${INTENT_RULES.length} phrasings)`);
    expect(snippets.length).toBeGreaterThan(60);
  });

  it.each(snippets)('%s', (line) => {
    expect(Step.parse(parseIntent(line)).action).toBe('component');
  });

  it('documents every component rule example', () => {
    const all = snippets.join('\n');
    const missing = COMPONENT_RULES.filter((r) => !snippets.includes(r.example) && !all.includes(r.example));
    expect(missing.map((r) => r.example)).toEqual([]);
  });
});

describe('docs/components.md', () => {
  const comp = readFileSync(new URL('../../docs/components.md', import.meta.url), 'utf8');
  it('has an adapter matrix that says real or emulated for every library', () => {
    for (const lib of ['ag-Grid', 'MUI', 'Kendo', 'DevExtreme', 'PrimeNG', 'PrimeFaces', 'Angular Material', 'Oracle JET', 'SAP UI5', 'Salesforce', 'Dynamics 365', 'TinyMCE', 'Quill', 'CKEditor', 'Chart.js', 'ECharts', 'Highcharts', 'noUiSlider', 'IMask']) {
      expect(comp, lib).toContain(lib);
    }
    expect(comp).toMatch(/emulated/i);
    expect(comp).toMatch(/real library/i);
  });
});
