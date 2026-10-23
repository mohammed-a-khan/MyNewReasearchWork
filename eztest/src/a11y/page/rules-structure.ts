/**
 * Document structure: title (2.4.2), language (3.1.1, 3.1.2), headings,
 * landmarks, bypass blocks (2.4.1) and duplicate IDs.
 */
import { accessibleName } from '../../browser/injected/page/accname.js';
import { flatParent, lowerTag, normalizeWhitespace } from '../../browser/injected/page/dom.js';
import { headingLevel } from '../../browser/injected/page/states.js';
import { LANDMARKS } from './aria-data.js';
import type { Ctx, DocInfo } from './context.js';
import type { RuleFn } from './rules-names.js';
import { getRole, isHiddenForAria, isTabbable, isVisible, quote } from './util.js';

/** Well-formed BCP 47 tag with a 2-3 letter primary language (or private-use / grandfathered i- tags). */
const LANG_RE = /^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-(?:[a-z\d]{5,8}|\d[a-z\d]{3}))*(?:-[\da-wyz](?:-[a-z\d]{2,8})+)*(?:-x(?:-[a-z\d]{1,8})+)?|x(?:-[a-z\d]{1,8})+|i-[a-z]{2,8})$/i;

export function validLang(v: string): boolean {
  return LANG_RE.test(v.trim());
}

const SKIP_LINK_TEXT = /\b(?:skip|jump|go to (?:the )?(?:main|content))\b|main content|zum inhalt|aller au contenu|saltar al contenido/i;
const IDREF_ATTRS = ['aria-labelledby', 'aria-describedby', 'aria-activedescendant', 'aria-errormessage', 'aria-controls', 'aria-owns', 'aria-flowto', 'aria-details', 'headers', 'list'];

function exposedRole(el: Element): string | null {
  return isHiddenForAria(el) ? null : getRole(el);
}

const headingMemo = new WeakMap<DocInfo, Element[]>();
const landmarkMemo = new WeakMap<DocInfo, Array<{ el: Element; role: string }>>();

function headings(_c: Ctx, d: DocInfo): Element[] {
  let h = headingMemo.get(d);
  if (!h) headingMemo.set(d, (h = d.elements.filter((el) => exposedRole(el) === 'heading')));
  return h;
}

function landmarks(_c: Ctx, d: DocInfo): Array<{ el: Element; role: string }> {
  const cached = landmarkMemo.get(d);
  if (cached) return cached;
  const out: Array<{ el: Element; role: string }> = [];
  for (const el of d.elements) {
    const r = getRole(el);
    if (r && LANDMARKS.has(r) && !isHiddenForAria(el)) out.push({ el, role: r });
  }
  landmarkMemo.set(d, out);
  return out;
}

function landmarkAncestor(el: Element): Element | null {
  for (let p = flatParent(el); p; p = flatParent(p)) {
    const r = getRole(p);
    if (r && LANDMARKS.has(r)) return p;
  }
  return null;
}

interface IdGroups {
  dupes: Array<{ id: string; els: Element[]; referenced: boolean }>;
  unique: Element[];
}
const idMemo = new WeakMap<Ctx, IdGroups>();

function idGroups(c: Ctx): IdGroups {
  const cached = idMemo.get(c);
  if (cached) return cached;
  const byRoot = new Map<Node, Map<string, Element[]>>();
  const refs = new Map<Node, Set<string>>();
  for (const el of c.all()) {
    const root = el.getRootNode();
    if (el.id) {
      let m = byRoot.get(root);
      if (!m) byRoot.set(root, (m = new Map()));
      const l = m.get(el.id);
      if (l) l.push(el);
      else m.set(el.id, [el]);
    }
    let r = refs.get(root);
    for (const a of IDREF_ATTRS) {
      const v = el.getAttribute(a);
      if (!v) continue;
      if (!r) refs.set(root, (r = new Set()));
      for (const id of v.trim().split(/\s+/)) r.add(id);
    }
    if (lowerTag(el) === 'label' && el.getAttribute('for')) {
      if (!r) refs.set(root, (r = new Set()));
      r.add(el.getAttribute('for') as string);
    }
  }
  const out: IdGroups = { dupes: [], unique: [] };
  for (const [root, m] of byRoot) {
    for (const [id, els] of m) {
      if (els.length === 1) out.unique.push(els[0]);
      else out.dupes.push({ id, els, referenced: refs.get(root)?.has(id) ?? false });
    }
  }
  idMemo.set(c, out);
  return out;
}

export const STRUCTURE_RULES: Record<string, RuleFn> = {
  'page.title'(c) {
    const d = c.docs[0];
    const html = d.doc.documentElement;
    if (!html) return;
    const t = normalizeWhitespace(d.doc.title || '');
    if (t) c.pass(html);
    else c.fail(html, d.doc.querySelector('title') ? 'The <title> element is empty.' : 'The document has no <title> element.');
  },

  'lang.page'(c) {
    for (const d of c.docs) {
      const html = d.doc.documentElement;
      if (!html || lowerTag(html) !== 'html') continue;
      const v = (html.getAttribute('lang') || html.getAttribute('xml:lang') || '').trim();
      if (v) c.pass(html);
      else c.fail(html, `The <html> element${d.top ? '' : ' of this frame'} has no lang attribute (for example lang="en").`);
    }
  },

  'lang.valid'(c) {
    for (const el of c.all()) {
      for (const attr of ['lang', 'xml:lang']) {
        const v = el.getAttribute(attr);
        if (v === null || !v.trim()) continue;
        if (validLang(v)) c.pass(el);
        else c.fail(el, `${attr}="${v}" is not a valid language tag (use a code such as "en", "en-GB", "pt-BR").`);
      }
    }
  },

  'heading.order'(c) {
    for (const d of c.docs) {
      let prev = 0;
      for (const h of headings(c, d)) {
        const level = headingLevel(h) ?? 2;
        if (prev && level > prev + 1) c.fail(h, `A level-${level} heading follows a level-${prev} heading; level ${prev + 1} is skipped.`);
        else c.pass(h);
        prev = level;
      }
    }
  },

  'heading.empty'(c) {
    for (const d of c.docs) {
      for (const h of headings(c, d)) {
        if (normalizeWhitespace(accessibleName(h))) c.pass(h);
        else c.fail(h, 'The heading has no text (or its text is hidden from assistive technology).');
      }
    }
  },

  'heading.level-one'(c) {
    const d = c.docs[0];
    if (!d.doc.body) return;
    const ok = headings(c, d).some((h) => headingLevel(h) === 1);
    if (ok) c.pass(d.doc.documentElement);
    else c.fail(d.doc.documentElement, 'The page has no level-one heading (<h1> or role="heading" aria-level="1").');
  },

  'landmark.main'(c) {
    const d = c.docs[0];
    if (!d.doc.body) return;
    if (landmarks(c, d).some((l) => l.role === 'main')) c.pass(d.doc.documentElement);
    else c.fail(d.doc.documentElement, 'The page has no <main> element or role="main".');
  },

  'landmark.single'(c) {
    for (const d of c.docs) {
      for (const role of ['main', 'banner', 'contentinfo']) {
        const list = landmarks(c, d).filter((l) => l.role === role && !landmarkAncestor(l.el) && isVisible(l.el));
        list.forEach((l, i) => (i === 0 ? c.pass(l.el) : c.fail(l.el, `The page has ${list.length} ${role} landmarks; keep one.`)));
      }
    }
  },

  'landmark.top-level'(c) {
    for (const d of c.docs) {
      for (const l of landmarks(c, d)) {
        if (l.role !== 'main' && l.role !== 'banner' && l.role !== 'contentinfo') continue;
        const outer = landmarkAncestor(l.el);
        if (outer) c.fail(l.el, `The ${l.role} landmark is inside a ${getRole(outer)} landmark (${c.localSelector(outer)}).`);
        else c.pass(l.el);
      }
    }
  },

  'landmark.unique'(c) {
    for (const d of c.docs) {
      const seen = new Map<string, Element>();
      for (const l of landmarks(c, d)) {
        if (l.role === 'main') continue;
        const name = normalizeWhitespace(accessibleName(l.el)).toLowerCase();
        const key = `${l.role}|${name}`;
        const first = seen.get(key);
        if (first) c.fail(l.el, `Another ${l.role} landmark has the same ${name ? `name ${quote(name)}` : 'empty name'} (${c.localSelector(first)}). Give each a distinct aria-label.`);
        else {
          seen.set(key, l.el);
          c.pass(l.el);
        }
      }
    }
  },

  'landmark.contained'(c) {
    for (const d of c.docs) {
      const body = d.doc.body;
      if (!body) continue;
      const lms = landmarks(c, d);
      if (!lms.length) {
        if (d.top && normalizeWhitespace(body.innerText || '')) c.fail(body, 'The page has no landmarks at all (main, nav, header, footer ...).');
        continue;
      }
      let stray = 0;
      const holders = new Set<Element>();
      for (const l of lms) for (let p: Element | null = l.el; p; p = flatParent(p)) holders.add(p);
      for (const el of d.elements) {
        let text = false;
        for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /[\p{L}\p{N}]/u.test((n as Text).data)) text = true;
        if (!text || /^(script|style|noscript|template|title|option)$/.test(lowerTag(el))) continue;
        if (landmarkAncestor(el) || (getRole(el) && LANDMARKS.has(getRole(el) as string))) continue;
        if (!isVisible(el) || isHiddenForAria(el)) continue;
        if (el.closest('dialog, [role="dialog"], [role="alertdialog"], [role="alert"], [role="status"], [role="log"], [aria-live], [role="tooltip"]')) continue;
        if (el.closest('a[href^="#"]')) continue; // skip links sit before the landmarks
        let top = el;
        for (let p = flatParent(el); p && p !== body && !holders.has(p); p = flatParent(p)) top = p;
        stray++;
        c.fail(top, `Text outside any landmark: ${quote(normalizeWhitespace((top as HTMLElement).innerText || top.textContent || ''), 50)}.`);
      }
      if (!stray) c.pass(body);
    }
  },

  'bypass.blocks'(c) {
    const d = c.docs[0];
    if (!d.doc.body) return;
    const links = d.elements.filter((e) => getRole(e) === 'link' && isTabbable(e)).length;
    if (links === 0) return;
    const hasMain = landmarks(c, d).some((l) => l.role === 'main');
    const hasHeading = headings(c, d).length > 0;
    const hasSkip = d.elements.some((e) => lowerTag(e) === 'a' && /^#./.test(e.getAttribute('href') || '') && !!targetOf(e));
    const hasFrames = d.elements.some((e) => lowerTag(e) === 'iframe' || lowerTag(e) === 'frame');
    if (hasMain || hasHeading || hasSkip || hasFrames) c.pass(d.doc.documentElement);
    else c.fail(d.doc.documentElement, 'There is no main landmark, no heading and no skip link, so keyboard users cannot bypass repeated content.');
  },

  'bypass.skip-link'(c) {
    for (const a of c.byTag('a')) {
      const href = a.getAttribute('href') || '';
      if (!/^#[^/!]/.test(href)) continue;
      const text = normalizeWhitespace(a.textContent || '') || a.getAttribute('aria-label') || '';
      if (!SKIP_LINK_TEXT.test(text)) continue;
      const t = targetOf(a);
      if (!t) c.fail(a, `The skip link points to ${href}, which does not exist on the page.`);
      else if (!isVisible(t) && !t.firstElementChild) c.fail(a, `The skip link points to ${href}, which is not rendered.`);
      else c.pass(a);
    }
  },

  'id.duplicate-referenced'(c) {
    const g = idGroups(c);
    for (const d of g.dupes) {
      if (!d.referenced) continue;
      d.els.slice(1).forEach((el) => c.fail(el, `id="${d.id}" is used ${d.els.length} times and is referenced by a label or ARIA attribute, which will pick the first one.`));
    }
    for (const el of g.unique) c.pass(el);
  },

  'id.duplicate'(c) {
    const g = idGroups(c);
    for (const d of g.dupes) {
      if (d.referenced) continue;
      d.els.slice(1).forEach((el) => c.fail(el, `id="${d.id}" is used ${d.els.length} times in this document.`));
    }
    for (const el of g.unique) c.pass(el);
  },
};

function targetOf(a: Element): Element | null {
  let id = (a.getAttribute('href') || '').slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    /* keep raw */
  }
  const root = a.getRootNode() as Document | ShadowRoot;
  return root.getElementById?.(id) ?? a.ownerDocument.getElementsByName(id)[0] ?? null;
}
