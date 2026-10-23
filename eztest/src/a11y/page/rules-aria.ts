/**
 * WAI-ARIA 1.2 validity: roles, state and property names and values,
 * required / supported / prohibited attributes, ID references, required
 * context and owned elements, aria-hidden and presentational children.
 */
import { deepElements, getByIdInTree, lowerTag } from '../../browser/injected/page/dom.js';
import { explicitRole, isPresentational } from '../../browser/injected/page/roles.js';
import { ATTRS, ROLES, supportsAttr } from './aria-data.js';
import { allowedRolesFor, NO_ROLE_ATTRS } from './html-aria.js';
import type { Ctx } from './context.js';
import type { RuleFn } from './rules-names.js';
import { accessibilityParent, ariaAttrNames, describeRole, getRole, isHiddenForAria, isTabbable, ownedElements, roleTokens } from './util.js';

const IDREF_ATTRS = ['aria-labelledby', 'aria-describedby', 'aria-activedescendant', 'aria-errormessage', 'aria-controls', 'aria-owns', 'aria-flowto', 'aria-details'];
const MUST_RESOLVE = new Set(['aria-labelledby', 'aria-describedby', 'aria-activedescendant', 'aria-errormessage']);

function withAria(c: Ctx): Element[] {
  return c.all().filter((el) => {
    for (const a of Array.from(el.attributes)) if (a.name.startsWith('aria-')) return true;
    return false;
  });
}

/** The role comes from the role attribute (not from the element). */
function explicitlyRoled(el: Element): string | null {
  if (!el.hasAttribute('role')) return null;
  const r = getRole(el);
  const e = explicitRole(el);
  return r && r === e ? r : null;
}

export function valueProblem(attr: string, raw: string): string | null {
  const def = ATTRS[attr];
  if (!def) return null;
  const v = raw.trim().toLowerCase();
  if (v === '' && def.type !== 'idref' && def.type !== 'idrefs') return null;
  switch (def.type) {
    case 'true/false':
      return v === 'true' || v === 'false' ? null : 'must be "true" or "false"';
    case 'true/false/undefined':
      return v === 'true' || v === 'false' || v === 'undefined' ? null : 'must be "true", "false" or "undefined"';
    case 'tristate':
      return v === 'true' || v === 'false' || v === 'mixed' || v === 'undefined' ? null : 'must be "true", "false" or "mixed"';
    case 'token':
      return def.values!.includes(v) ? null : `must be one of ${def.values!.map((x) => `"${x}"`).join(', ')}`;
    case 'tokens': {
      const bad = v.split(/\s+/).filter((t) => !def.values!.includes(t));
      return bad.length ? `has unknown token(s) ${bad.map((x) => `"${x}"`).join(', ')}` : null;
    }
    case 'integer': {
      if (!/^-?\d+$/.test(v)) return 'must be an integer';
      return def.min !== undefined && Number(v) < def.min ? `must be at least ${def.min}` : null;
    }
    case 'number':
      return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/.test(v) ? null : 'must be a number';
    case 'idref':
      return /\s/.test(raw.trim()) ? 'must be a single ID' : raw.trim() ? null : 'must not be empty';
    default:
      return null;
  }
}

/** Is a required state supplied by the native element itself (HTML-AAM)? */
function nativelyProvided(el: Element, attr: string): boolean {
  const tag = lowerTag(el);
  const type = tag === 'input' ? ((el as HTMLInputElement).type || '').toLowerCase() : '';
  switch (attr) {
    case 'aria-checked': return type === 'checkbox' || type === 'radio';
    case 'aria-valuenow': return type === 'range' || type === 'number' || tag === 'meter' || tag === 'progress';
    case 'aria-level': return /^h[1-6]$/.test(tag);
    case 'aria-expanded': return tag === 'select';
    default: return false;
  }
}

const LENIENT_CHILDREN: Record<string, string[]> = {
  menu: ['separator'], menubar: ['separator'], table: ['caption'], grid: ['caption'], treegrid: ['caption'], list: [], listbox: [],
};

export const ARIA_RULES: Record<string, RuleFn> = {
  'aria.role-valid'(c) {
    for (const el of c.all()) {
      const tokens = roleTokens(el);
      if (!tokens.length) continue;
      if (explicitRole(el) || tokens.includes('directory')) {
        c.pass(el);
        continue;
      }
      const abstract = tokens.filter((t) => ROLES[t]?.abstract);
      c.fail(el, abstract.length
        ? `role="${el.getAttribute('role')}" uses the abstract role ${abstract.map((t) => `"${t}"`).join(', ')}, which authors must not use.`
        : `role="${el.getAttribute('role')}" contains no WAI-ARIA role.`);
    }
  },

  'aria.attr-name'(c) {
    for (const el of withAria(c)) {
      const bad = ariaAttrNames(el).filter((a) => !ATTRS[a]);
      if (bad.length) c.fail(el, `Unknown attribute${bad.length > 1 ? 's' : ''} ${bad.join(', ')}${suggest(bad[0])}.`);
      else c.pass(el);
    }
  },

  'aria.attr-value'(c) {
    for (const el of withAria(c)) {
      const problems: string[] = [];
      for (const a of ariaAttrNames(el)) {
        const p = valueProblem(a, el.getAttribute(a) ?? '');
        if (p) problems.push(`${a}="${el.getAttribute(a)}" ${p}`);
      }
      if (problems.length) c.fail(el, problems.join('; ') + '.');
      else c.pass(el);
    }
  },

  'aria.attr-required'(c) {
    for (const el of c.all()) {
      const r = explicitlyRoled(el);
      if (!r) continue;
      let required = ROLES[r]?.required ?? [];
      if (r === 'separator' && isTabbable(el)) required = ['aria-valuenow'];
      if (!required.length) continue;
      const missing = required.filter((a) => !(el.getAttribute(a) || '').trim() && !nativelyProvided(el, a));
      if (missing.length) c.fail(el, `role="${r}" requires ${missing.join(' and ')}.`);
      else c.pass(el);
    }
  },

  'aria.attr-allowed'(c) {
    for (const el of withAria(c)) {
      const r = getRole(el);
      if (!r) {
        // No ARIA role (ARIA in HTML): only global attributes, plus a few per input type.
        const tag = lowerTag(el);
        if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || tag.includes('-')) continue;
        const extra = tag === 'input' ? NO_ROLE_ATTRS[((el as HTMLInputElement).type || '').toLowerCase()] ?? [] : [];
        const bad = ariaAttrNames(el).filter((a) => ATTRS[a] && !ATTRS[a].global && !extra.includes(a) && a !== 'aria-expanded');
        if (bad.length) c.fail(el, `${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not allowed on <${tag}${tag === 'input' ? ` type="${(el as HTMLInputElement).type}"` : ''}>, which has no ARIA role; only global attributes apply.`);
        else c.pass(el);
        continue;
      }
      if (isPresentational(r) || !ROLES[r]) continue;
      const bad = ariaAttrNames(el).filter((a) => ATTRS[a] && !ATTRS[a].global && !supportsAttr(r, a) && !(a === 'aria-placeholder' && r === 'combobox'));
      if (bad.length) c.fail(el, `${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not supported on ${describeRole(r)}.`);
      else c.pass(el);
    }
  },

  'aria.attr-prohibited'(c) {
    for (const el of c.all()) {
      const label = (el.getAttribute('aria-label') || '').trim();
      const by = (el.getAttribute('aria-labelledby') || '').trim();
      if (!label && !by) continue;
      const r = getRole(el);
      if (!r || isHiddenForAria(el)) continue;
      if (isTabbable(el) || (el as HTMLElement).isContentEditable || lowerTag(el) === 'body' || lowerTag(el) === 'html') continue;
      if (ROLES[r]?.nameProhibited || isPresentational(r)) {
        c.fail(el, `${label ? 'aria-label' : 'aria-labelledby'} is not allowed on ${describeRole(r)} (<${lowerTag(el)}>): the role cannot be named, so the label is dropped.`);
      } else c.pass(el);
    }
  },

  'aria.reference'(c) {
    for (const el of withAria(c)) {
      let checked = false;
      for (const attr of IDREF_ATTRS) {
        const v = (el.getAttribute(attr) || '').trim();
        if (!v) continue;
        checked = true;
        const ids = v.split(/\s+/);
        const found = ids.filter((id) => getByIdInTree(el, id));
        if (found.length === ids.length) continue;
        const missing = ids.filter((id) => !found.includes(id)).map((id) => `"${id}"`).join(', ');
        if (found.length === 0 && MUST_RESOLVE.has(attr)) {
          c.fail(el, `${attr} references ${missing}, which ${ids.length > 1 ? 'do' : 'does'} not exist in this document or shadow root.`);
        } else if (attr === 'aria-controls' || attr === 'aria-owns') {
          if (el.getAttribute('aria-expanded') !== 'true' && found.length === 0) continue; // collapsed popups are often not rendered
          c.review(el, `${attr} references ${missing}, which ${ids.length - found.length > 1 ? 'are' : 'is'} missing.`);
        } else c.review(el, `${attr} references ${missing}, which ${ids.length - found.length > 1 ? 'are' : 'is'} missing.`);
      }
      if (checked) c.pass(el);
    }
  },

  'aria.parent'(c) {
    for (const el of c.all()) {
      const r = explicitlyRoled(el);
      const context = r ? ROLES[r]?.context : undefined;
      if (!r || !context || isHiddenForAria(el)) continue;
      const p = accessibilityParent(el);
      const pr = p ? getRole(p) : null;
      if (pr && context.includes(pr)) c.pass(el);
      else c.fail(el, `role="${r}" must be inside ${context.map((x) => `role="${x}"`).join(' or ')}${pr ? `; its parent in the accessibility tree is ${describeRole(pr)}` : ''}.`);
    }
  },

  'aria.children'(c) {
    for (const el of c.all()) {
      const r = explicitlyRoled(el);
      const want = r ? ROLES[r]?.owned : undefined;
      if (!r || !want || isHiddenForAria(el) || el.getAttribute('aria-busy') === 'true') continue;
      const owned = ownedElements(el);
      if (!owned.length) {
        c.review(el, `role="${r}" owns no ${want.join('/')} elements. Check it is populated when it is shown.`);
        continue;
      }
      const extra = LENIENT_CHILDREN[r] ?? [];
      const bad = owned.filter((o) => {
        const or = getRole(o);
        return !or || !(want.includes(or) || extra.includes(or));
      });
      if (bad.length) {
        const kinds = [...new Set(bad.map((b) => getRole(b) ?? `<${lowerTag(b)}>`))].join(', ');
        c.fail(el, `role="${r}" may only own ${want.join(', ')}; it also owns ${kinds}.`);
      } else c.pass(el);
    }
  },

  'aria.hidden-focusable'(c) {
    for (const host of c.all()) {
      if (host.getAttribute('aria-hidden') !== 'true') continue;
      if (host.parentElement?.closest('[aria-hidden="true"]')) continue; // reported from the outermost hidden subtree
      const focusable = [host, ...deepElements(host)].filter((e) => isTabbable(e));
      if (!focusable.length) {
        c.pass(host);
        continue;
      }
      const hostSel = focusable.some((f) => f !== host) ? c.localSelector(host) : '';
      for (const f of focusable) c.fail(f, `This focusable element is inside aria-hidden="true"${f === host ? '' : ` (on ${hostSel})`}: keyboard users reach it but screen readers announce nothing.`);
    }
  },

  'aria.hidden-body'(c) {
    for (const d of c.docs) {
      for (const el of [d.doc.documentElement, d.doc.body]) {
        if (!el) continue;
        if (el.getAttribute('aria-hidden') === 'true') c.fail(el, `aria-hidden="true" on <${lowerTag(el)}> hides the whole page from assistive technology.`);
        else c.pass(el);
      }
    }
  },

  'aria.nested-interactive'(c) {
    for (const el of c.all()) {
      const r = getRole(el);
      if (!r || !ROLES[r]?.presentationalChildren || lowerTag(el) === 'input' || isHiddenForAria(el)) continue;
      if (!el.firstElementChild && !el.shadowRoot) {
        c.pass(el);
        continue;
      }
      const inner = deepElements(el).filter((d) => isTabbable(d));
      if (inner.length) c.fail(el, `${cap(describeRole(r))} contains focusable ${inner.slice(0, 3).map((i) => `<${lowerTag(i)}>`).join(', ')}; its children are presentational, so those are not announced.`);
      else c.pass(el);
    }
  },

  'aria.role-allowed'(c) {
    for (const el of c.all()) {
      const tokens = roleTokens(el);
      if (!tokens.length || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
      const tag = lowerTag(el);
      if (tag.includes('-')) continue;
      const role = explicitRole(el) ?? (tokens.includes('directory') ? 'directory' : null);
      if (!role) continue; // aria.role-valid reports it
      const allowed = allowedRolesFor(el, tag);
      if (allowed === 'any' || allowed.includes(role) || role.startsWith('doc-') || role.startsWith('graphics-')) {
        c.pass(el);
        continue;
      }
      c.fail(el, allowed.length
        ? `role="${role}" is not allowed on <${tag}${tag === 'input' ? ` type="${(el as HTMLInputElement).type}"` : ''}>; ARIA in HTML allows ${allowed.map((x) => `"${x}"`).join(', ')}.`
        : `<${tag}${tag === 'input' ? ` type="${(el as HTMLInputElement).type}"` : ''}> must not have a role attribute (ARIA in HTML).`);
    }
  },

  'aria.presentation-conflict'(c) {
    for (const el of c.all()) {
      const e = explicitRole(el);
      if (e !== 'none' && e !== 'presentation') continue;
      const r = getRole(el);
      if (r === e) c.pass(el);
      else c.fail(el, `role="${e}" is ignored because the element is focusable or has global ARIA attributes; it keeps ${r ? describeRole(r) : 'its native'} role.`);
    }
  },

  'aria.deprecated'(c) {
    for (const el of c.all()) {
      const tokens = roleTokens(el);
      const names = ariaAttrNames(el);
      if (!tokens.length && !names.length) continue;
      const attrs = names.filter((a) => ATTRS[a]?.deprecated);
      const problems: string[] = [];
      if (tokens[0] === 'directory') problems.push('role="directory" (use role="list")');
      problems.push(...attrs);
      if (problems.length) c.fail(el, `Deprecated in WAI-ARIA 1.2: ${problems.join(', ')}.`);
      else c.pass(el);
    }
  },
};

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function suggest(bad: string): string {
  let best = '';
  let score = 3;
  for (const name of Object.keys(ATTRS)) {
    const d = distance(bad, name);
    if (d < score) {
      score = d;
      best = name;
    }
  }
  return best ? ` (did you mean ${best}?)` : '';
}

function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
