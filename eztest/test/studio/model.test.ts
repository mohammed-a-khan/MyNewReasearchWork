/** Visual step model round trips (.ez keeps comments and headers; YAML/JSON re-serialize), formatting and hover explanations. */
import { describe, expect, it } from '../support/testkit.js';
import YAML from 'yaml';
import { applySteps, convertText, explainLine, formatText, journeyModel, validateText } from '../../src/studio/index.js';

const EZ = [
  'Journey: Checkout',
  'Tags: @smoke',
  '# Sign in first',
  '',
  'Log in as manager',
  'Go to /orders/new',
  '  Expect the URL contains "/orders/new"',
  '# then submit',
  'Click the "Submit order" button',
  '  Expect the page contains "created"',
  '',
].join('\n');

describe('journey model', () => {
  it('lists steps as cards with action, target, value, expectations and line ranges', () => {
    const m = journeyModel(EZ, 'ez');
    expect(m.ok).toBe(true);
    expect(m.header).toMatchObject({ name: 'Checkout', tags: ['smoke'] });
    expect(m.steps.map((s) => s.text)).toEqual(['Log in as manager', 'Go to /orders/new', 'Click the "Submit order" button']);
    expect(m.steps[0]).toMatchObject({ action: 'login', value: 'manager', line: 5, endLine: 5 });
    expect(m.steps[1]).toMatchObject({ action: 'navigate', expects: ['the URL contains "/orders/new"'], line: 6, endLine: 7 });
    expect(m.steps[2]).toMatchObject({ action: 'click', target: 'the "Submit order" button', expects: ['the page contains "created"'] });
  });

  it('reports problems instead of cards for a journey that does not parse', () => {
    const m = journeyModel('Journey: X\nOpne /\n', 'ez');
    expect(m.ok).toBe(false);
    expect(m.validation.errors[0].line).toBe(2);
  });

  it('reorders, duplicates, edits, inserts and deletes .ez steps, keeping headers and comments', () => {
    // Move the click first, duplicate login, edit navigation, insert a new step, delete nothing.
    const r = applySteps(EZ, 'ez', [
      { from: 2 },
      { from: 0 },
      { text: 'Log in as manager', expects: [] },
      { from: 1, text: 'Go to /orders', expects: ['the URL contains "/orders"'] },
      { text: 'Reload the page' },
    ]);
    expect(r.validation.ok).toBe(true);
    const lines = r.content.split('\n');
    expect(lines.slice(0, 4)).toEqual(['Journey: Checkout', 'Tags: @smoke', '# Sign in first', '']);
    expect(r.content).toContain('Click the "Submit order" button\n  Expect the page contains "created"');
    expect(r.content).toContain('Go to /orders\n  Expect the URL contains "/orders"\n# then submit');
    expect(r.content.trimEnd().endsWith('Reload the page')).toBe(true);
    const m = journeyModel(r.content, 'ez');
    expect(m.steps.map((s) => s.action)).toEqual(['click', 'login', 'login', 'navigate', 'navigate']);
    // Duplicated step ids are made unique by the parser.
    expect(new Set(m.steps.map((s) => s.id)).size).toBe(5);
    // Deleting a step.
    const d = applySteps(r.content, 'ez', [{ from: 0 }, { from: 3 }]);
    expect(journeyModel(d.content, 'ez').steps.map((s) => s.text)).toEqual(['Click the "Submit order" button', 'Go to /orders']);
  });

  it('points an invalid edited step at its card with suggestions', () => {
    try {
      applySteps(EZ, 'ez', [{ from: 0 }, { text: 'Clik the Save button' }]);
      expect.unreachable();
    } catch (e) {
      const err = e as { status: number; extra: { index: number; suggestions: string[] } };
      expect(err.status).toBe(422);
      expect(err.extra.index).toBe(1);
      expect(err.extra.suggestions.some((s) => s.startsWith('Click'))).toBe(true);
    }
    expect(() => applySteps(EZ, 'ez', [])).toThrow(/at least one step/);
    expect(() => applySteps('Journey: X\nOpne /\n', 'ez', [{ from: 0 }])).toThrow(/Fix the problems/);
  });

  it('round-trips YAML and JSON journeys through the journey model', () => {
    for (const format of ['yaml', 'json'] as const) {
      const text = convertText(EZ, 'ez', format);
      const m = journeyModel(text, format);
      expect(m.steps).toHaveLength(3);
      expect(m.steps[1].expects).toEqual(['URL contains "/orders/new"']);
      const r = applySteps(text, format, [{ from: 2 }, { from: 0 }, { from: 0 }, { text: 'Open /help', expects: ['the page contains "Help"'] }]);
      expect(r.validation.ok).toBe(true);
      const j = format === 'json' ? JSON.parse(r.content) : YAML.parse(r.content);
      expect(j.steps.map((s: { action: string }) => s.action)).toEqual(['click', 'login', 'login', 'navigate']);
      expect(new Set(j.steps.map((s: { id: string }) => s.id)).size).toBe(4);
      expect(j.steps[3].postconditions[0]).toMatchObject({ type: 'pageContainsText', value: 'Help' });
      // And it converts back to .ez.
      expect(convertText(r.content, format, 'ez')).toMatch(/Open \/help/);
    }
  });
});

describe('language services', () => {
  it('formats .ez without changing meaning and keeps comments', () => {
    const messy = 'journey:   Tidy me  \ntags: @a\n\n\n# note\nOpen /\nExpect the page contains "x"   \n\n\n\nClick the "Go" button\n';
    const f = formatText(messy, 'ez');
    expect(f).toBe('Journey: Tidy me\nTags: @a\n\n# note\nOpen /\n  Expect the page contains "x"\n\nClick the "Go" button\n');
    expect(validateText(f, 'ez').ok).toBe(true);
    expect(formatText('{"a":1}', 'json')).toBe('{\n  "a": 1\n}\n');
    expect(formatText('# keep\nname:   X\nsteps: [ "Open /" ]\n', 'yaml')).toMatch(/^# keep\nname: X/);
  });

  it('explains steps, expectations, headers and unknown lines', () => {
    expect(explainLine('Click the "Sign in" button')).toMatchObject({ kind: 'step', action: 'click', target: 'the "Sign in" button', rule: { category: 'Click and mouse' } });
    expect(explainLine('Capture the text of testid=total as orderTotal')).toMatchObject({ kind: 'step', action: 'capture', captureAs: 'orderTotal' });
    expect(explainLine('Expect the page contains "Saved"').kind).toBe('expect');
    expect(explainLine('Risk: 4')).toMatchObject({ kind: 'header' });
    const bad = explainLine('Clik the Save button');
    expect(bad.kind).toBe('error');
    expect(bad.suggestions?.length).toBeGreaterThan(0);
    expect(explainLine('# a comment').kind).toBe('comment');
  });

  it('reports a column for validation errors', () => {
    const r = validateText('Journey: X\n   Opne /\n', 'ez');
    expect(r.errors[0]).toMatchObject({ line: 2, column: 4 });
    const j = validateText('{\n  "name": "x",\n  oops\n}', 'json');
    expect(j.errors[0].line).toBe(3);
  });
});
