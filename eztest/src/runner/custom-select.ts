/**
 * Choosing an option, for every kind of dropdown real apps use: a native <select>, a custom select (a focusable
 * box that opens a listbox or menu, as in Vue/React/Angular UI kits), and a typeahead (an input that shows matching
 * options as you type: autocompletes, searchable selects). The step is the same for all of them:
 * `Select "Admin" from the "User Role" dropdown`.
 */
import type { Locator, Page } from '../browser/index.js';
import { EzTestError, sleep } from '../core/index.js';

type Kind = 'native' | 'typeahead' | 'box';

async function kindOf(loc: Locator, timeout: number): Promise<Kind> {
  return loc.evaluate((el) => {
    if (el instanceof HTMLSelectElement) return 'native';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable) return 'typeahead';
    const inner = el.querySelector('input:not([type=hidden])');
    return inner && !(inner as HTMLInputElement).readOnly ? 'typeahead' : 'box';
  }, undefined, { timeout }) as Promise<Kind>;
}

/** Where the options of an open dropdown are, most specific first. */
function optionLocators(page: Page, value: string, exact: boolean): Locator[] {
  const lists = page.locator('[role=listbox], [role=menu], [role=tree], [role=grid], ul, ol, [class*=dropdown], [class*=menu], [class*=option], [class*=list], [class*=popup], [class*=overlay]');
  return [
    page.getByRole('option', { name: value, exact }),
    page.getByRole('menuitem', { name: value, exact }),
    page.getByRole('menuitemradio', { name: value, exact }),
    page.getByRole('treeitem', { name: value, exact }),
    page.getByRole('gridcell', { name: value, exact }),
    lists.getByText(value, { exact }),
  ].map((l) => l.filter({ visible: true }));
}

async function findOption(page: Page, value: string, deadline: number, allowPartial: boolean): Promise<Locator | undefined> {
  for (;;) {
    for (const exact of allowPartial ? [true, false] : [true]) {
      for (const l of optionLocators(page, value, exact)) {
        const n = await l.count().catch(() => 0);
        // Several visible matches: the most recently opened list is rendered last (portals append to <body>).
        if (n >= 1) return n === 1 ? l : l.last();
      }
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(100);
  }
}

/** Select `value` in the dropdown `loc` (native, custom or typeahead). */
export async function selectValue(loc: Locator, value: string, timeout: number): Promise<void> {
  const kind = await kindOf(loc, timeout);
  if (kind === 'native') {
    await loc.selectOption(value, { timeout });
    return;
  }
  const page = loc.page();
  const deadline = Date.now() + timeout;
  if (kind === 'typeahead') {
    const input = (await loc.evaluate((el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable, undefined, { timeout })) ? loc : loc.locator('input:not([type=hidden])').first();
    await input.click({ timeout });
    await input.fill(value, { timeout });
  } else {
    await loc.click({ timeout });
  }
  let option = await findOption(page, value, Math.min(deadline, Date.now() + Math.max(2000, timeout / 2)), kind === 'typeahead');
  if (!option && kind === 'box') {
    // Some boxes open on keyboard or a second click only (the first one focused them).
    await loc.press('Enter', { timeout }).catch(() => undefined);
    option = await findOption(page, value, deadline, false);
  }
  if (!option) {
    throw new EzTestError(`No option "${value}" appeared after opening the dropdown${kind === 'typeahead' ? ` and typing "${value}"` : ''}`, 'NOT_FOUND', { value, kind });
  }
  await option.click({ timeout: Math.max(1000, deadline - Date.now()) });
}

/** Whether the dropdown now shows `value` (the native selection, the input's value, or the box's text). */
export async function selectedValue(loc: Locator): Promise<string[]> {
  return loc
    .evaluate((el) => {
      if (el instanceof HTMLSelectElement) return Array.from(el.selectedOptions).flatMap((o) => [o.value, o.label]);
      const input = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : (el.querySelector('input:not([type=hidden])') as HTMLInputElement | null);
      const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
      return [input?.value ?? '', text].filter(Boolean);
    }, undefined, { timeout: 2000 })
    .catch(() => [] as string[]);
}
