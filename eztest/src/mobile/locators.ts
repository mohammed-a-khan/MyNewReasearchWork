/**
 * From EZ targets to device finders. A target's locator candidates are written
 * in the shared vocabulary ("the "Login" button" -> role=button "Login", text
 * "Login"; `testid=...`; `#id`) or with native strategies (`accessibility
 * id=`, `id=`, `class=`, `predicate=` on iOS, `xpath=`). Each candidate
 * expands into an ordered list of agent finders for the platform and context
 * (native app or web view): accessibility id first, then exact text (or an
 * NSPredicate on iOS), then XPath over the hierarchy. As on the web, a finder
 * is accepted only when it matches exactly one element.
 */
import type { LocatorCandidate } from '../core/index.js';
import type { FindStrategy } from './session.js';
import { KIND_TAGS, xpathLiteral, type NativeKind, type NativePlatform } from './source.js';

/** One find request. */
export interface Finder {
  using: FindStrategy;
  value: string;
}

export const NATIVE_STRATEGY: Partial<Record<LocatorCandidate['strategy'], FindStrategy>> = {
  accessibilityId: 'accessibility id',
  id: 'id',
  className: 'class',
  xpath: 'xpath',
  iosPredicate: 'predicate',
};

const ROLE_KIND: Record<string, NativeKind> = {
  button: 'button', link: 'link', textbox: 'textbox', combobox: 'textbox', searchbox: 'textbox', checkbox: 'checkbox',
  radio: 'checkbox', switch: 'switch', img: 'img', image: 'img', heading: 'text', tab: 'button', menuitem: 'button',
  option: 'text', cell: 'text', list: 'list', alert: 'text', status: 'text',
};

/** Native kind implied by a candidate (role, or the field-ish strategies). */
export function kindOfCandidate(c: LocatorCandidate): NativeKind {
  if (c.strategy === 'role') return ROLE_KIND[c.value] ?? 'generic';
  if (c.strategy === 'label' || c.strategy === 'placeholder') return 'textbox';
  if (c.strategy === 'altText') return 'img';
  return 'generic';
}

/** XPath predicate restricting the element kind by tag (Android class names, XCUIElementType names). */
export function kindPredicate(kind: NativeKind): string | undefined {
  if (kind === 'generic') return undefined;
  const parts = KIND_TAGS[kind].map((t) => (t.length <= 3 || /^[a-z]/.test(t) ? `local-name()=${xpathLiteral(t)}` : `contains(local-name(),${xpathLiteral(t)})`));
  if (kind === 'button') parts.push(`@clickable='true'`);
  return parts.join(' or ');
}

/** XPath predicate: any naming attribute equals (or contains) the text. */
function namePredicate(text: string, exact: boolean, attrs = ['text', 'content-desc', 'label', 'name', 'value', 'hint', 'placeholderValue']): string {
  const lit = xpathLiteral(text);
  return attrs.map((a) => (exact ? `@${a}=${lit}` : `contains(@${a},${lit})`)).join(' or ');
}

function predString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Finders for a named element of a kind, most specific first. */
function namedFinders(name: string, kind: NativeKind, exact: boolean, platform: NativePlatform): Finder[] {
  const out: Finder[] = [];
  if (exact) out.push({ using: 'accessibility id', value: name });
  if (platform === 'ios') {
    const op = exact ? '==' : 'CONTAINS';
    out.push({ using: 'predicate', value: `label ${op} ${predString(name)} OR name ${op} ${predString(name)} OR value ${op} ${predString(name)}` });
  } else out.push({ using: exact ? 'text' : 'text contains', value: name });
  const kp = kindPredicate(kind);
  const np = namePredicate(name, exact);
  if (kp) out.push({ using: 'xpath', value: `//*[(${kp}) and (${np})]` });
  out.push({ using: 'xpath', value: `//*[${np}]` });
  return out;
}

/** HTML elements implicitly carrying an ARIA role (for role targets in web views). */
const WEB_ROLE: Record<string, string> = {
  button: `self::button or @role='button' or (self::input and (@type='submit' or @type='button' or @type='reset'))`,
  link: `self::a[@href] or @role='link'`,
  textbox: `(self::input and not(@type) ) or (self::input and (@type='text' or @type='email' or @type='search' or @type='password' or @type='tel' or @type='url' or @type='number')) or self::textarea or @role='textbox'`,
  checkbox: `(self::input and @type='checkbox') or @role='checkbox'`,
  radio: `(self::input and @type='radio') or @role='radio'`,
  heading: `self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::h6 or @role='heading'`,
  img: `self::img or @role='img'`,
  combobox: `self::select or @role='combobox'`,
};

/** Finders in a web view (HTML). */
function webFinders(c: LocatorCandidate): Finder[] {
  const v = c.value;
  const css = (sel: string): Finder[] => [{ using: 'css', value: sel }];
  switch (c.strategy) {
    case 'css': return css(v);
    case 'xpath': return [{ using: 'xpath', value: v }];
    case 'id': return [{ using: 'id', value: v }];
    case 'testId': return css(`[data-testid=${JSON.stringify(v)}]`);
    case 'accessibilityId': return [{ using: 'accessibility id', value: v }];
    case 'placeholder': return css(`[placeholder=${JSON.stringify(v)}]`);
    case 'altText': return css(`[alt=${JSON.stringify(v)}]`);
    case 'title': return css(`[title=${JSON.stringify(v)}]`);
    case 'role': {
      const roleTest = WEB_ROLE[v] ?? `@role=${xpathLiteral(v)}`;
      if (c.name === undefined) return [{ using: 'xpath', value: `//*[${roleTest}]` }];
      const lit = xpathLiteral(c.name);
      const named = c.exact === false
        ? `contains(normalize-space(.),${lit}) or contains(@aria-label,${lit}) or contains(@value,${lit})`
        : `normalize-space(.)=${lit} or @aria-label=${lit} or @value=${lit} or @title=${lit}`;
      return [{ using: 'xpath', value: `//*[(${roleTest}) and (${named})]` }, { using: c.exact === false ? 'text contains' : 'text', value: c.name }];
    }
    case 'text':
    case 'label':
      return [{ using: c.exact === false ? 'text contains' : 'text', value: v }];
    default:
      return [];
  }
}

/** The finders for one candidate in a context (NATIVE_APP, or a web view name). */
export function findersFor(c: LocatorCandidate, platform: NativePlatform, context = 'NATIVE_APP'): Finder[] {
  if (context !== 'NATIVE_APP') return webFinders(c);
  const exact = c.exact ?? true;
  const direct = NATIVE_STRATEGY[c.strategy];
  if (direct) return [{ using: direct, value: c.value }];
  switch (c.strategy) {
    case 'testId':
      // React Native testID: accessibility identifier on iOS, resource id (or content-desc) on Android.
      return [{ using: 'accessibility id', value: c.value }, { using: 'id', value: c.value }];
    case 'css': {
      const m = /^#([\w.:/-]+)$/.exec(c.value);
      return m ? [{ using: 'id', value: m[1] }, { using: 'accessibility id', value: m[1] }] : [];
    }
    case 'role': {
      const kind = kindOfCandidate(c);
      if (c.name === undefined) {
        const kp = kindPredicate(kind);
        return kp ? [{ using: 'xpath', value: `//*[${kp}]` }] : [];
      }
      return namedFinders(c.name, kind, exact, platform);
    }
    case 'label':
    case 'placeholder':
      return namedFinders(c.value, 'textbox', exact, platform);
    case 'altText':
      return namedFinders(c.value, 'img', exact, platform);
    case 'text':
    case 'title':
      return namedFinders(c.value, 'generic', exact, platform);
    default:
      return [];
  }
}

export function describeFinder(f: Finder): string {
  return `${f.using}=${JSON.stringify(f.value)}`;
}
