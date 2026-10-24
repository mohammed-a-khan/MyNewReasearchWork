/**
 * Entry point of the page bundle: builds the engine object.
 * engine.ts bundles this file to one IIFE expression that evaluates to the
 * result of `createEngine()`.
 */
import type { ElementStateName } from '../contract.js';
import type { EztestEngine } from '../engine-api.js';
import { accessibleDescription, accessibleName } from './accname.js';
import { actionability } from './actionability.js';
import { describe, fingerprint, scan } from './describe.js';
import { flatChildren, isElement, lowerTag, normalizeWhitespace, withCaches } from './dom.js';
import { getRole, isPresentational, withRoleCache } from './roles.js';
import { elementText, matchesText, query, queryDetailed } from './selector.js';
import { checkedState, expandedState, headingLevel, isDisabled, isEditable, pressedState, selectedState } from './states.js';
import { clear, dispatchEvent, fill, focus, innerText, inputValue, selectOptions, selectText, setChecked, textContent } from './values.js';
import { isHiddenForAria, isVisible } from './visibility.js';

export const ENGINE_VERSION = 'eztest-engine/1.0';

function checkState(el: Element, state: ElementStateName): boolean {
  return withCaches(() =>
    withRoleCache(() => {
      switch (state) {
        case 'attached': return el.isConnected;
        case 'visible': return isVisible(el);
        case 'hidden': return !isVisible(el);
        case 'enabled': return !isDisabled(el);
        case 'disabled': return isDisabled(el);
        case 'editable': return isEditable(el);
        case 'focused': {
          let a: Element | null = el.ownerDocument.activeElement;
          while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
          return a === el;
        }
        case 'checked':
        case 'unchecked': {
          const c = checkedState(el);
          if (c === undefined) throw new Error('The element is not a checkbox or radio button (nor an element with a checked state such as role=checkbox)');
          return state === 'checked' ? c === true : c === false;
        }
        default: throw new Error(`Unknown element state "${String(state)}"`);
      }
    }),
  );
}

/** YAML-ish accessibility snapshot of a subtree: one line per named/structural node. */
function ariaSnapshot(root: Element): string {
  return withCaches(() =>
    withRoleCache(() => {
      const lines: string[] = [];
      const ownText = (el: Element, depth: number) => {
        if (/^(script|style|template|noscript)$/.test(lowerTag(el))) return;
        let own = '';
        for (const c of flatChildren(el)) if (c.nodeType === 3) own += (c as Text).data;
        own = normalizeWhitespace(own);
        if (own) lines.push(`${'  '.repeat(depth)}- text ${JSON.stringify(own)}`);
      };
      const walk = (el: Element, depth: number) => {
        if (isHiddenForAria(el)) return;
        const role = getRole(el);
        let nextDepth = depth;
        if (role && role !== 'generic' && !isPresentational(role)) {
          const name = accessibleName(el);
          const attrs: string[] = [];
          const lvl = headingLevel(el);
          if (lvl !== undefined && role === 'heading') attrs.push(`level=${lvl}`);
          const c = checkedState(el);
          if (c !== undefined) attrs.push(`checked=${c}`);
          const p = pressedState(el);
          if (p) attrs.push(`pressed=${p}`);
          const x = expandedState(el);
          if (x !== undefined) attrs.push(`expanded=${x}`);
          if (selectedState(el)) attrs.push('selected');
          if (isDisabled(el) && role !== 'document') attrs.push('disabled');
          lines.push(`${'  '.repeat(depth)}- ${role}${name ? ' ' + JSON.stringify(name) : ''}${attrs.map((a) => ` [${a}]`).join('')}`);
          nextDepth = depth + 1;
          if (!name) ownText(el, nextDepth);
        } else ownText(el, depth);
        for (const c of flatChildren(el)) if (isElement(c)) walk(c, nextDepth);
      };
      walk(root, 0);
      return lines.join('\n');
    }),
  );
}

export function createEngine(): EztestEngine {
  return {
    version: ENGINE_VERSION,
    query,
    queryDetailed,
    actionability,
    checkState,
    accessibleName,
    accessibleDescription,
    role: (el) => withRoleCache(() => getRole(el)),
    describe,
    ariaSnapshot,
    isVisible: (el) => withCaches(() => isVisible(el)),
    isHiddenForAria: (el) => withCaches(() => isHiddenForAria(el)),
    checked: (el) => withRoleCache(() => checkedState(el)),
    pressed: (el) => withRoleCache(() => pressedState(el)),
    expanded: expandedState,
    selected: (el) => withRoleCache(() => selectedState(el)),
    disabled: isDisabled,
    level: (el) => withRoleCache(() => headingLevel(el)),
    editable: isEditable,
    fingerprint,
    scan,
    normalizeWhitespace,
    elementText,
    innerText,
    textContent,
    matchesText,
    inputValue,
    selectOptions,
    setChecked,
    fill,
    clear,
    selectText,
    focus,
    dispatchEvent,
  };
}
