/**
 * Turn what the page reported about an element into descriptions the intent
 * grammar understands, best first. A description is only offered as the
 * "human" one when the page measured its first locator as unique; otherwise
 * stable fallbacks (data-testid, id, exact text, unique CSS path) follow.
 */
import type { ElementFingerprint, LocatorCandidate } from '../core/index.js';
import { analyzeDescription, quoteText, type TargetKind } from '../intent/index.js';
import type { ElementInfo } from './page-script.js';

export interface RecordedTarget {
  /** Candidate descriptions, best first (the composer uses the first that round-trips). */
  descriptions: string[];
  /** True when the element had a human name that was not unique on the page. */
  ambiguous: boolean;
  /** Why the human description was not used (for warnings). */
  note?: string;
  /** Locator candidates measured in the page: role+name, label, testId, id, css. */
  candidates: LocatorCandidate[];
  fingerprint: ElementFingerprint;
  kind: TargetKind;
  /** Plain words for messages, e.g. 'the "Submit order" button'. */
  label: string;
}

const ROLE_KIND: Record<string, TargetKind> = {
  button: 'button', link: 'link', tab: 'tab', menuitem: 'menuitem', menuitemcheckbox: 'menuitem', menuitemradio: 'menuitem',
  heading: 'heading', option: 'option', img: 'img', checkbox: 'checkbox', radio: 'radio', switch: 'switch', slider: 'slider',
  textbox: 'textbox', searchbox: 'textbox', spinbutton: 'textbox', combobox: 'combobox', listbox: 'combobox',
};

const KIND_WORD: Partial<Record<TargetKind, string>> = {
  button: 'button', link: 'link', tab: 'tab', menuitem: 'menu item', heading: 'heading', option: 'option', img: 'image',
  checkbox: 'checkbox', radio: 'radio button', switch: 'switch', slider: 'slider', textbox: 'field', combobox: 'dropdown',
};

/** Kinds whose names are always quoted (they are usually visible text). */
const QUOTED: ReadonlySet<TargetKind> = new Set<TargetKind>(['button', 'link', 'tab', 'menuitem', 'heading', 'option', 'img']);

const SAFE_UNQUOTED = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;
const SAFE_TESTID = /^[^\s"'`\\]+$/;
const SAFE_ID = /^[A-Za-z][\w-]*$/;

/** The element kind used for the description. */
export function kindOf(info: ElementInfo): TargetKind {
  if (info.tag === 'select') return 'combobox';
  if (info.field || (info.tag === 'input' && info.type === 'file')) return 'textbox';
  return (info.role && ROLE_KIND[info.role]) || 'generic';
}

function tryQuote(s: string): string | undefined {
  try {
    return quoteText(s);
  } catch {
    return undefined;
  }
}

/** `the <name> <kind word>`, unquoted when that parses back to the same kind and name, else quoted. */
export function phrase(kind: TargetKind, name: string): string | undefined {
  const word = KIND_WORD[kind];
  if (!word || !name) return undefined;
  const ok = (d: string) => {
    const a = analyzeDescription(d);
    return a.kind === kind && a.name === name;
  };
  if (!QUOTED.has(kind) && SAFE_UNQUOTED.test(name)) {
    const d = `the ${name} ${word}`;
    if (ok(d)) return d;
  }
  const q = tryQuote(name);
  if (!q) return undefined;
  const d = `the ${q} ${word}`;
  return ok(d) ? d : undefined;
}

function fingerprintOf(info: ElementInfo): ElementFingerprint {
  const attributes: Record<string, string> = {};
  if (info.type) attributes.type = info.type;
  if (info.nameAttr) attributes.name = info.nameAttr;
  if (info.href) attributes.href = info.href;
  if (info.title) attributes.title = info.title;
  if (info.alt) attributes.alt = info.alt;
  const fp: ElementFingerprint = { tag: info.tag, classes: info.classes, path: info.css };
  if (info.role) fp.role = info.role;
  if (info.name) fp.name = info.name;
  if (info.text) fp.text = info.text.slice(0, 120);
  if (info.id) fp.id = info.id;
  if (info.testId) fp.testId = info.testId;
  if (info.label) fp.label = info.label;
  if (info.placeholder) fp.placeholder = info.placeholder;
  if (Object.keys(attributes).length) fp.attributes = attributes;
  if (info.box) fp.box = info.box;
  return fp;
}

function measuredCandidates(info: ElementInfo): LocatorCandidate[] {
  const out: LocatorCandidate[] = [];
  if (info.role && info.name) out.push({ strategy: 'role', value: info.role, name: info.name, exact: true });
  if (info.label) out.push({ strategy: 'label', value: info.label, exact: true });
  if (info.placeholder) out.push({ strategy: 'placeholder', value: info.placeholder, exact: true });
  if (info.testId) out.push({ strategy: 'testId', value: info.testId });
  if (info.id && SAFE_ID.test(info.id)) out.push({ strategy: 'css', value: `#${info.id}` });
  out.push({ strategy: 'css', value: info.css });
  return out;
}

/** Build the ordered description alternatives for an element. */
export function buildTarget(info: ElementInfo): RecordedTarget {
  const kind = kindOf(info);
  const c = info.counts;
  const descriptions: string[] = [];
  let ambiguous = false;
  let note: string | undefined;
  let human: string | undefined;

  if (kind === 'textbox' || kind === 'combobox') {
    if (info.label) {
      const d = phrase(kind, info.label);
      if (d && c.label === 1) human = d;
      else if (d) {
        ambiguous = c.label > 1;
        note = `label "${info.label}" matches ${c.label} elements`;
      }
    }
    if (!human && !info.label && kind === 'textbox' && info.placeholder) {
      const q = tryQuote(info.placeholder);
      const d = q ? `the ${q} field` : undefined;
      if (d && c.placeholder === 1 && c.placeholderAsLabel === 0 && analyzeDescription(d).name === info.placeholder) human = d;
      else if (d) {
        ambiguous = c.placeholder > 1;
        note = `placeholder "${info.placeholder}" matches ${c.placeholder} elements`;
      }
    }
  } else if (kind !== 'generic' && info.name) {
    const d = phrase(kind, info.name);
    if (d && c.roleName === 1) human = d;
    else if (d) {
      ambiguous = c.roleName > 1;
      note = `${info.role} "${info.name}" matches ${c.roleName} elements`;
    }
  }
  // A repeated name in a table or list row: say which row (`the "Edit" button in the row containing "Acme"`).
  if (!human && ambiguous && info.rowText && kind !== 'generic' && info.name) {
    const d = phrase(kind, info.name);
    const q = tryQuote(info.rowText);
    if (d && q) {
      human = `${d} in the row containing ${q}`;
      ambiguous = false;
      note = undefined;
    }
  }
  if (human) descriptions.push(human);
  if (info.testId && c.testId === 1 && SAFE_TESTID.test(info.testId)) descriptions.push(`testid=${info.testId}`);
  if (info.id && c.id === 1 && SAFE_ID.test(info.id)) descriptions.push(`#${info.id}`);
  if (kind === 'generic' && info.text && c.text === 1) {
    const q = tryQuote(info.text);
    if (q) descriptions.push(`the ${q} text`);
  }
  descriptions.push(`css=${info.css}`);

  const label = human ?? (info.name ? `${info.role ?? info.tag} "${info.name}"` : descriptions[0]);
  return { descriptions, ambiguous, note, candidates: measuredCandidates(info), fingerprint: fingerprintOf(info), kind, label };
}
