/** The debugger's block-aware step outline agrees with the .ez parser on structure, ids and expectations. */
import { describe, expect, it } from '../support/testkit.js';
import { parseEzScript } from '../../src/intent/index.js';
import { debugOutline } from '../../src/studio/debug-outline.js';

const TEXT = `Journey: Loop and branch
Id: loop-branch

Open /login
Repeat 2 times
  Type "bob" into the Username field
  Verify the page contains "Sign in"
End
If the page contains "Sign in" then
  Click the "Sign in" button
Otherwise
  Open /login
End
Open /login
Expect the URL contains "/login"
`;

describe('debugOutline', () => {
  it('maps lines to top-level indices, nested step ids, blocks and expectations', () => {
    const o = debugOutline(TEXT);
    expect(o.ok).toBe(true);
    const rows = o.entries.map((e) => ({ line: e.line, endLine: e.endLine, id: e.id, depth: e.depth, index: e.index, block: e.block, expects: e.expects.length }));
    expect(rows).toEqual([
      { line: 4, endLine: 4, id: 'open-login', depth: 0, index: 0, block: false, expects: 0 },
      { line: 5, endLine: 8, id: 'repeat-2-times', depth: 0, index: 1, block: true, expects: 0 },
      { line: 6, endLine: 7, id: 'type-bob-into-the-username-field', depth: 1, index: undefined, block: false, expects: 1 },
      { line: 9, endLine: 13, id: 'if-the-page-contains-sign-in-then', depth: 0, index: 2, block: true, expects: 0 },
      { line: 10, endLine: 10, id: 'click-the-sign-in-button', depth: 1, index: undefined, block: false, expects: 0 },
      { line: 12, endLine: 12, id: 'open-login-2', depth: 1, index: undefined, block: false, expects: 0 },
      { line: 14, endLine: 15, id: 'open-login-3', depth: 0, index: 3, block: false, expects: 1 },
    ]);
    // Same ids and top-level order as the parser.
    const j = parseEzScript(TEXT);
    expect(o.entries.filter((e) => e.depth === 0).map((e) => e.id)).toEqual(j.steps.map((s) => s.id));
    expect(o.entries.filter((e) => e.parent === 1).map((e) => e.id)).toEqual(j.steps[1].steps!.map((s) => s.id));
    expect(o.entries.filter((e) => e.parent === 3).map((e) => e.id)).toEqual([...j.steps[2].steps!, ...j.steps[2].else!].map((s) => s.id));
  });

  it('reports problems without throwing', () => {
    const o = debugOutline('Journey: X\nOpen /a\nRepeat 2 times\n  Open /b\n');
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/End/);
    expect(o.entries.map((e) => e.id)).toEqual(['open-a', 'repeat-2-times', 'open-b']);
  });
});
