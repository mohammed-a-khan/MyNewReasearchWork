/**
 * Turning a source tool's locator into an .ez target description whose
 * parsed candidates include that exact locator (first, whenever the grammar
 * allows it). The description is what a person reads; the candidate keeps the
 * conversion faithful.
 */
import type { LocatorCandidate } from '../core/index.js';
import { describeTarget, quoteText } from '../intent/index.js';
import { sameCandidate } from './builder.js';

/** How the target is used, which picks the most natural element word. */
export type TargetHint = 'field' | 'dropdown' | 'checkbox' | 'click' | 'generic';

const ROLE_WORD: Record<string, string> = {
  button: 'button', link: 'link', tab: 'tab', heading: 'heading', menuitem: 'menu item', option: 'option', cell: 'cell',
  checkbox: 'checkbox', radio: 'radio button', switch: 'switch', slider: 'slider', textbox: 'field', combobox: 'dropdown',
  img: 'image', dialog: 'dialog', region: 'region', navigation: 'navigation', list: 'list', table: 'table', row: 'row',
};

function q(s: string): string | undefined {
  try {
    return quoteText(s);
  } catch {
    return undefined;
  }
}

export function cssEscapeId(id: string): string {
  return id.replace(/([^\w-])/g, '\\$1');
}

/** Human (and passthrough) descriptions to try for a candidate, most readable first. */
function descriptionsFor(c: LocatorCandidate, hint: TargetHint): string[] {
  const out: string[] = [];
  const v = q(c.value);
  switch (c.strategy) {
    case 'role': {
      const n = c.name !== undefined ? q(c.name) : undefined;
      const word = ROLE_WORD[c.value];
      if (n && word) out.push(`the ${n} ${word}`);
      if (n) out.push(`role=${c.value}[name=${n}]`);
      else out.push(`role=${c.value}`);
      break;
    }
    case 'label':
      if (v) {
        if (hint === 'dropdown') out.push(`the ${v} dropdown`);
        out.push(`the ${v} field`);
        if (hint === 'checkbox') out.push(`the ${v} checkbox`);
      }
      break;
    case 'placeholder':
      if (v) out.push(`the ${v} field`);
      break;
    case 'text':
      if (v) out.push(c.exact === false ? `the ${v} message` : v, `text=${v}`);
      break;
    case 'testId':
      if (/^[^"'\s]+$/.test(c.value)) out.push(`testid=${c.value}`);
      if (v) out.push(`the element with test id ${v}`);
      break;
    case 'altText':
      if (v) out.push(`the ${v} image`);
      break;
    case 'title':
      if (v) out.push(v);
      break;
    case 'css': {
      const id = /^#((?:[\w-]|\\.)+)$/.exec(c.value);
      if (id) {
        const raw = id[1].replace(/\\(.)/g, '$1');
        const word = hint === 'field' ? 'field' : hint === 'dropdown' ? 'dropdown' : hint === 'checkbox' ? 'checkbox' : 'element';
        const rv = q(raw);
        if (rv) out.push(`the ${word} with id ${rv}`);
      }
      out.push(c.value, `css=${c.value}`);
      break;
    }
    case 'xpath':
      out.push(c.value, `xpath=${c.value}`);
      break;
  }
  return out;
}

/** Attribute selectors used when a strategy has no .ez phrasing of its own. */
function cssFallback(c: LocatorCandidate): string | undefined {
  const attr = c.strategy === 'placeholder' ? 'placeholder' : c.strategy === 'altText' ? 'alt' : c.strategy === 'title' ? 'title' : undefined;
  if (!attr || c.value.includes('"')) return undefined;
  return `[${attr}="${c.value}"]`;
}

function indexIn(desc: string, c: LocatorCandidate): number {
  try {
    return describeTarget(desc).locators.findIndex((l) => sameCandidate(l, c));
  } catch {
    return -1;
  }
}

/**
 * A description whose parsed candidates include `c`: the first readable one
 * where `c` is tried first, else the first where it appears at all, else a
 * CSS attribute fallback. Undefined when nothing reproduces the locator.
 */
export function describeLocator(c: LocatorCandidate, hint: TargetHint = 'generic'): string | undefined {
  const options = descriptionsFor(c, hint);
  const first = options.find((d) => indexIn(d, c) === 0);
  if (first) return first;
  const any = options.find((d) => indexIn(d, c) > 0);
  if (any) return any;
  const fb = cssFallback(c);
  if (fb && indexIn(fb, { strategy: 'css', value: fb }) === 0) return fb;
  return undefined;
}

/** The candidate the description will actually be checked against (CSS fallback included). */
export function expectedCandidate(c: LocatorCandidate, description: string): LocatorCandidate {
  if (indexIn(description, c) >= 0) return c;
  return { strategy: 'css', value: description };
}
