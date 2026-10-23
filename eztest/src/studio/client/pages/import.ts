/** Import: pick project files, preview the conversion to journeys (coverage, TODO lines), then write them. */
import { api } from '../core/api.js';
import { clear, h, uid } from '../core/dom.js';
import { splitList } from '../core/format.js';
import { registerPage } from '../core/registry.js';
import { refreshJourneys } from '../core/state.js';
import { button, card, iconButton, stat } from '../ui/badge.js';
import { icon } from '../ui/icons.js';
import { createSplit } from '../ui/split.js';
import { toast } from '../ui/toast.js';

interface FsEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  importable?: boolean;
  journey?: boolean;
}

interface Preview {
  files: string[];
  coverage: { sourceSteps: number; convertedSteps: number; assertions: number; convertedAssertions: number };
  warnings: string[];
  todo: Array<{ file: string; line: number; original: string; reason: string }>;
  journeys: Array<{ id: string; name: string; kind: string; file: string; line: number; ez: string; runnable: boolean; todo: number }>;
  written?: { ezFiles: string[]; unconvertedFiles: string[]; reportMd: string; reportJson: string };
}

export function registerImportPage(): void {
  registerPage({
    id: 'import',
    title: 'Import',
    icon: 'import',
    order: 70,
    shortcut: 'Alt+7',
    mount(ctx) {
      const heading = h('h1', { class: 'pane-title', tabindex: '-1', text: 'Import tests' });
      const dirLabel = h('code', { class: 'fs-dir' });
      const upBtn = iconButton('Up one folder', 'up', () => parent && void browse(parent));
      const fsList = h('ul', { class: 'fs-list', 'aria-label': 'Files and folders' });
      const selectedList = h('ul', { class: 'chips', 'aria-label': 'Selected for import' });
      const ids = { kind: uid('imp-kind'), tags: uid('imp-tags'), out: uid('imp-out'), mode: uid('imp-mode') };
      // Manual test cases (CSV / Excel): keep them as manual cases, or hybrid, instead of TODO lines (docs/manual-testing.md).
      const mode = h('select', { id: ids.mode, class: 'input' }, [['', 'Automate (TODO for what is not understood)'], ['manual', 'Keep as manual cases (Manual: steps)'], ['hybrid', 'Hybrid: automate what reads, keep the rest manual']].map(([v, t]) => h('option', { value: v, text: t })));
      const kind = h(
        'select',
        { id: ids.kind, class: 'input' },
        [['', 'Detect automatically'], ['gherkin', 'Cucumber / Gherkin'], ['playwright', 'Playwright'], ['selenium', 'Selenium'], ['manual-csv', 'Manual cases (CSV)'], ['manual-xlsx', 'Manual cases (Excel)'], ['task-recorder', 'D365 Task Recorder']].map(([v, t]) => h('option', { value: v, text: t })),
      );
      const tags = h('input', { id: ids.tags, class: 'input', placeholder: 'imported' });
      const out = h('input', { id: ids.out, class: 'input mono', value: 'journeys/imported' });
      const status = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
      const preview = h('div', { class: 'imp-preview' });
      const writeRow = h('div', { class: 'row', hidden: true }, h('div', { class: 'field grow' }, h('label', { for: ids.out, text: 'Write journeys to folder' }), out), button('Write files', { kind: 'primary', icon: 'save', onclick: () => void write() }));
      let current = '.';
      let parent: string | undefined;
      let selected: string[] = [];

      const picker = h(
        'aside',
        { class: 'picker', 'aria-label': 'Choose files in the project' },
        h('div', { class: 'pane-head' }, heading, h('div', { class: 'pane-actions' }, upBtn)),
        h('p', { class: 'fs-path' }, icon('folder', { size: 13 }), dirLabel),
        h('div', { class: 'fs-scroll' }, fsList),
      );
      const options = h(
        'div',
        { class: 'imp-main' },
        card(
          'Selected',
          h(
            'div',
            { class: 'stack' },
            selectedList,
            h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: ids.kind, text: 'Format' }), kind), h('div', { class: 'field' }, h('label', { for: ids.tags, text: 'Tags for imported journeys' }), tags)),
            h('div', { class: 'field' }, h('label', { for: ids.mode, text: 'Manual test cases' }), mode),
            h('div', { class: 'row' }, button('Preview import', { kind: 'primary', icon: 'eye', onclick: () => void runPreview() })),
            status,
          ),
        ),
        preview,
        writeRow,
      );
      const split = createSplit({ direction: 'row', first: picker, second: h('div', { class: 'page-scroll' }, options), size: 320, min: 240, storageKey: 'import-picker', label: 'Resize file picker' });
      ctx.root.classList.add('page-import');
      ctx.root.appendChild(split.el);

      const renderSelected = () => {
        clear(selectedList);
        if (!selected.length) selectedList.appendChild(h('li', { class: 'muted', text: 'Nothing selected' }));
        for (const p of selected) selectedList.appendChild(h('li', null, h('code', { text: p }), iconButton(`Remove ${p}`, 'close', () => toggle(p, false))));
      };
      const toggle = (p: string, on: boolean) => {
        selected = on ? [...new Set([...selected, p])] : selected.filter((x) => x !== p);
        renderSelected();
        fsList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => (cb.checked = selected.includes(cb.value)));
      };
      const browse = async (dir: string) => {
        try {
          const r = await api.get<{ dir: string; parent?: string; entries: FsEntry[] }>(`/api/fs?dir=${encodeURIComponent(dir)}`);
          current = r.dir;
          parent = r.parent;
          dirLabel.textContent = r.dir;
          upBtn.disabled = !r.parent;
          clear(fsList);
          for (const e of r.entries) {
            const id = uid('fs');
            const cb = h('input', { type: 'checkbox', id, value: e.path, checked: selected.includes(e.path), disabled: e.type === 'file' && !e.importable, onchange: (ev: Event) => toggle(e.path, (ev.target as HTMLInputElement).checked) });
            fsList.appendChild(
              e.type === 'dir'
                ? h('li', { class: 'fs-item' }, cb, h('label', { for: id, class: 'sr-only', text: `Select folder ${e.name}` }), h('button', { type: 'button', class: 'fs-open', 'aria-label': `Open folder ${e.name}`, onclick: () => void browse(e.path) }, icon('folder', { size: 14 }), h('span', { text: `${e.name}/` })))
                : h('li', { class: ['fs-item', !e.importable && 'muted'] }, cb, h('label', { for: id }, icon('file', { size: 14 }), h('span', { text: e.name + (e.importable ? '' : ' (not importable)') }))),
            );
          }
          if (!r.entries.length) fsList.appendChild(h('li', { class: 'muted', text: 'Empty folder' }));
        } catch (e) {
          status.textContent = `Cannot open folder: ${(e as Error).message}`;
        }
      };
      const bodyOf = () => ({ paths: selected, kind: kind.value || undefined, tags: splitList(tags.value), ...(mode.value ? { mode: mode.value } : {}) });
      const render = (r: Preview) => {
        clear(preview);
        const c = r.coverage;
        preview.appendChild(
          card(
            'Preview',
            h(
              'div',
              { class: 'stack' },
              h('div', { class: 'stats' }, stat(r.files.length, 'Files'), stat(r.journeys.length, 'Tests'), stat(`${c.convertedSteps}/${c.sourceSteps}`, 'Steps converted'), stat(`${c.convertedAssertions}/${c.assertions}`, 'Assertions converted'), stat(r.todo.length, 'TODO lines', r.todo.length ? 'warn' : undefined)),
              r.warnings.map((w) => h('p', { class: 'warn-text', text: `Warning: ${w}` })),
              r.todo.length
                ? h(
                    'details',
                    null,
                    h('summary', { text: `Not converted (${r.todo.length} TODO lines)` }),
                    h('table', { class: 'table compact' }, h('caption', { class: 'sr-only', text: 'Source lines that were not converted' }), h('thead', null, h('tr', null, ['Location', 'Original', 'Reason'].map((t) => h('th', { scope: 'col', text: t })))), h('tbody', null, r.todo.map((t) => h('tr', null, h('td', { text: `${t.file}:${t.line}` }), h('td', null, h('code', { text: t.original })), h('td', { text: t.reason }))))),
                  )
                : null,
              h('h3', { class: 'h3', text: 'Converted journeys' }),
              r.journeys.map((j) => h('details', { class: 'imp-journey' }, h('summary', { text: `${j.name} (${j.kind}, ${j.file}:${j.line})${j.runnable ? '' : ' – nothing runnable'}${j.todo ? `, ${j.todo} TODO` : ''}` }), h('pre', { class: 'code-preview', tabindex: '0', text: j.ez }))),
              r.written ? h('div', null, h('h3', { class: 'h3', text: 'Written' }), h('ul', { id: 'imp-written', class: 'bullets' }, [...r.written.ezFiles, ...r.written.unconvertedFiles, r.written.reportMd, r.written.reportJson].map((f) => h('li', null, h('code', { text: f }))))) : null,
            ),
          ),
        );
      };
      const runPreview = async () => {
        status.textContent = 'Importing…';
        try {
          const r = await api.post<Preview>('/api/import/preview', bodyOf());
          status.textContent = `Preview ready: ${r.journeys.length} tests.`;
          render(r);
          writeRow.hidden = false;
        } catch (e) {
          status.textContent = `Import failed: ${(e as Error).message}`;
        }
      };
      const write = async () => {
        try {
          const r = await api.post<Preview>('/api/import/write', { ...bodyOf(), outDir: out.value.trim() });
          status.textContent = `Wrote ${r.written?.ezFiles.length ?? 0} journey files to ${out.value.trim()}.`;
          render(r);
          void refreshJourneys();
          toast(status.textContent, { kind: 'success' });
        } catch (e) {
          status.textContent = `Write failed: ${(e as Error).message}`;
        }
      };
      // Formats added by importer plugins (importers.plugins in eztest.config.yaml) join the list.
      const loadFormats = async () => {
        try {
          const r = await api.get<{ formats: Array<{ name: string; title: string; plugin: boolean }> }>('/api/import/formats');
          const have = new Set([...kind.querySelectorAll('option')].map((o) => (o as HTMLOptionElement).value));
          for (const f of r.formats) if (f.plugin && !have.has(f.name)) kind.appendChild(h('option', { value: f.name, text: `${f.title} (plugin)` }));
        } catch {
          // The built-in formats are already listed.
        }
      };
      renderSelected();
      let loaded = false;
      return {
        show() {
          if (!loaded) {
            loaded = true;
            void loadFormats();
            void browse(current);
          }
        },
        focus: () => heading.focus(),
      };
    },
  });
}
