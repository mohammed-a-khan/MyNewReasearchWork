/** Target matching every data row of a table description ("the Recent orders table"). */
import type { Target } from '../core/index.js';
import { analyzeDescription, describeTarget } from './target.js';

export function tableRowsTarget(tableDescription: string): Target {
  const description = `rows in ${tableDescription.trim()}`;
  const t = describeTarget(tableDescription);
  const css = t.locators.find((l) => l.strategy === 'css');
  if (css && t.locators.length === 1) return { description, locators: [{ strategy: 'css', value: `${css.value} tbody tr` }] };
  const a = analyzeDescription(tableDescription);
  if (a.kind === 'table' && a.name) {
    const n = a.name.replace(/"/g, '\\"');
    return {
      description,
      locators: [
        { strategy: 'css', value: `table[aria-label="${n}"] tbody tr` },
        { strategy: 'css', value: `table:has(caption:text-is("${n}")) tbody tr` },
      ],
    };
  }
  throw new Error(`Cannot count rows of "${tableDescription}": name the table (e.g. "the Recent orders table") or give a CSS selector`);
}
