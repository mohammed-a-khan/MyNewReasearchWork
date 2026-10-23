/**
 * CodeMirror 6 setup for journey files (bundled into the client; no CDN).
 * Each open file has its own EditorState (doc, history, language, linter);
 * one EditorView shows the active one.
 */
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, startCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { forceLinting, lintGutter, lintKeymap, linter } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import type { Issue } from '../../core/state.js';
import { ezCompletions, ezHover, lintSource, yamlCompletions, type Format } from './assist.js';
import { ezLanguage } from './ezlang.js';
import { sdkCompletions } from './sdk.js';

export interface EditorStateOptions {
  path: string;
  format: Format;
  content: string;
  onChange(state: EditorState): void;
  onValidated(r: { ok: boolean; errors: Issue[]; journey?: { name: string; steps: number } }): void;
  onCursor?(line: number): void;
}

/**
 * Extra editor extensions contributed by other features (e.g. the debugger's
 * breakpoint gutter). Each factory gets the file being edited.
 */
export const editorExtensions: Array<(file: { path: string; format: Format }) => Extension> = [];

/** Nonce the page's CSP allows for the editor's own <style> element. */
const STYLE_NONCE = document.querySelector<HTMLMetaElement>('meta[name="eztest-style-nonce"]')?.content ?? '';

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-font-size)', backgroundColor: 'var(--editor-bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'var(--editor-gutter-bg)', color: 'var(--text-faint)', border: 'none', borderRight: '1px solid var(--border-subtle)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--editor-active-line)', color: 'var(--text)' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--editor-selection) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-tooltip': { backgroundColor: 'var(--surface-overlay)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '6px', boxShadow: 'var(--shadow-lg)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text)' },
  '.cm-completionDetail': { color: 'var(--text-muted)', fontStyle: 'normal', marginLeft: '1em' },
  '.cm-completionInfo': { padding: '6px 8px', maxWidth: '28rem' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)' },
  '.cm-searchMatch': { backgroundColor: 'var(--warn-soft)', outline: '1px solid var(--warn)' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--danger)', textUnderlineOffset: '3px' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-muted)' },
});

function languageFor(format: Format): Extension {
  if (format === 'ts') return javascript({ typescript: true });
  if (format === 'json') return json();
  if (format === 'yaml') return yaml();
  return ezLanguage;
}

export function createEditorState(o: EditorStateOptions): EditorState {
  const format = o.format;
  const completionSource = format === 'ez' ? ezCompletions : format === 'yaml' ? yamlCompletions : format === 'ts' ? sdkCompletions : () => null;
  return EditorState.create({
    doc: o.content,
    extensions: [
      editorExtensions.map((f) => f({ path: o.path, format })),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(classHighlighter),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      autocompletion({ override: [completionSource], activateOnTyping: true, icons: true, maxRenderedOptions: 60 }),
      lintGutter(),
      linter(lintSource(() => format, o.onValidated), { delay: 350 }),
      format === 'ez' ? hoverTooltip(ezHover, { hoverTime: 400 }) : [],
      languageFor(format),
      theme,
      EditorView.cspNonce.of(STYLE_NONCE),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': `Journey source: ${o.path}`, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) o.onChange(u.state);
        if ((u.selectionSet || u.docChanged) && o.onCursor) o.onCursor(u.state.doc.lineAt(u.state.selection.main.head).number);
      }),
    ],
  });
}

export function createEditorView(parent: HTMLElement, state: EditorState): EditorView {
  return new EditorView({ state, parent });
}

/** Move the cursor to a 1-based line (and column) and scroll it into the middle. */
export function goToLine(view: EditorView, line: number, column = 1, focus = true): void {
  const doc = view.state.doc;
  const ln = doc.line(Math.max(1, Math.min(doc.lines, line)));
  const pos = Math.min(ln.to, ln.from + Math.max(0, column - 1));
  view.dispatch({ selection: EditorSelection.range(ln.from + (/^\s*/.exec(ln.text)?.[0].length ?? 0), ln.to), effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  if (focus) view.focus();
}

/** Replace the whole document as one undoable change. */
export function replaceDoc(view: EditorView, text: string, userEvent = 'input.replace'): void {
  const cur = view.state.doc.toString();
  if (cur === text) return;
  // Keep the change minimal so undo, cursor and scroll behave.
  let start = 0;
  while (start < cur.length && start < text.length && cur[start] === text[start]) start++;
  let endCur = cur.length;
  let endNew = text.length;
  while (endCur > start && endNew > start && cur[endCur - 1] === text[endNew - 1]) {
    endCur--;
    endNew--;
  }
  view.dispatch({ changes: { from: start, to: endCur, insert: text.slice(start, endNew) }, userEvent });
}

export { forceLinting, startCompletion, undo, redo };
