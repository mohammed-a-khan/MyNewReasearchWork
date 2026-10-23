/**
 * Syntax highlighting for `.ez` journeys: header keys and values, the step
 * verb, Expect/Verify lines, quoted text, ${variables}, locators, URLs,
 * numbers, `as <name>` captures, `[id=… optional]` annotations and comments.
 */
import { StreamLanguage, type StreamParser } from '@codemirror/language';

export const HEADER_RE = /^(journey|name|id|tags|role|requirements?|risk|base\s*url|variables|vars|description|lenses|data)\s*:/i;
export const EXPECT_RE = /^(?:(?:then|and|also)\s+)?(?:expect|verify)\b/i;

interface EzState {
  inSteps: boolean;
  first: boolean;
  header: string;
  afterAs: boolean;
}

const parser: StreamParser<EzState> = {
  name: 'ez',
  startState: () => ({ inSteps: false, first: true, header: '', afterAs: false }),
  copyState: (s) => ({ ...s }),
  token(stream, st) {
    if (stream.sol()) {
      st.first = true;
      st.header = '';
      st.afterAs = false;
    }
    if (stream.eatSpace()) return null;
    if (st.first) {
      st.first = false;
      if (stream.match(/^(?:#|\/\/).*/)) return 'comment';
      if (!st.inSteps) {
        const m = stream.match(HEADER_RE) as RegExpMatchArray | null;
        if (m) {
          st.header = m[1].toLowerCase().replace(/\s+/g, ' ');
          return 'propertyName';
        }
      }
      if (stream.match(EXPECT_RE)) return 'controlKeyword';
      st.inSteps = true;
      stream.match(/^(?:(?:and|then|when|given|but|also|next|finally|first)\s+)*(?:(?:i|we|the user|user|they)\s+)?/i);
      if (stream.match(/^[A-Za-z][\w-]*/)) return 'keyword';
    }
    if (st.header) {
      if (st.header === 'journey' || st.header === 'name') {
        stream.skipToEnd();
        return 'heading';
      }
      if (st.header === 'tags' && stream.match(/^@?[\w-]+/)) return 'labelName';
      if (st.header === 'risk' && stream.match(/^\d+/)) return 'number';
      if (st.header === 'role' && stream.match(/^[\w-]+/)) return 'typeName';
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^\$\{[^}]*\}?/)) return 'variableName';
    if (stream.match(/^\[(?:\s*(?:id\s*=\s*[\w.-]+|optional|timeout\s*=\s*[\d.]+\s*(?:ms|s|m)?|risk\s*=\s*[1-5])\s*)+\]\s*$/i)) return 'meta';
    if (stream.match(/^(?:testid|css|xpath|role|label|text|placeholder|alt|title)=/i)) return 'attributeName';
    if (stream.match(/^(?:https?:\/\/\S+|\/[\w./?=&%#:-]*)/)) return 'url';
    if (stream.match(/^\d+(?:\.\d+)?\b/)) return 'number';
    if (stream.match(/^(?:as|into|from|to|with|on|using)\b/i)) {
      st.afterAs = /^as$/i.test(stream.current());
      return 'operatorKeyword';
    }
    if (st.afterAs && stream.match(/^[A-Za-z_][\w.-]*/)) {
      st.afterAs = false;
      return 'variableName.definition';
    }
    st.afterAs = false;
    if (!stream.match(/^[^\s"$[]+/)) stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '#' } },
};

export const ezLanguage = StreamLanguage.define(parser);

export interface OutlineItem {
  line: number;
  text: string;
  kind: 'step' | 'expect';
}

/** Steps (and their expectations) of `.ez` text by line, without a server round trip. */
export function ezOutline(text: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  let inSteps = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) return;
    if (!inSteps && HEADER_RE.test(t)) return;
    if (inSteps && EXPECT_RE.test(t)) {
      out.push({ line: i + 1, text: t, kind: 'expect' });
      return;
    }
    inSteps = true;
    out.push({ line: i + 1, text: t, kind: 'step' });
  });
  return out;
}

/** Steps of YAML/JSON journey text, found by their `intent:` keys. */
export function structuredOutline(text: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = /^\s*(?:-\s*)?"?intent"?\s*:\s*"?(.*?)"?,?\s*$/.exec(raw);
    if (m && m[1]) out.push({ line: i + 1, text: m[1].replace(/\\"/g, '"'), kind: 'step' });
  });
  return out;
}

/** Variables a journey defines itself: Variables header, Data aliases and `as <name>` captures. */
export function localVariables(text: string): string[] {
  const vars = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    const v = /^(?:variables|vars)\s*:\s*(.*)$/i.exec(t);
    if (v) for (const m of v[1].matchAll(/([A-Za-z_][\w.-]*)\s*=/g)) vars.add(m[1]);
    const d = /^data\s*:\s*(.*)$/i.exec(t);
    if (d) for (const m of d[1].matchAll(/\bas\s+(\w+)/gi)) vars.add(m[1]);
    for (const m of t.matchAll(/\b(?:as|store\s+as)\s+([A-Za-z_][\w.-]*)\s*(?:\[.*\])?$/gi)) vars.add(m[1]);
  }
  return [...vars];
}
