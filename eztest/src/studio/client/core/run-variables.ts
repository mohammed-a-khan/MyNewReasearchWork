/**
 * Run-time variables: values a journey uses as `${name}` that the project does not supply, such as a recorded
 * password. The Run page shows a field for each; starting a run elsewhere (the editor's Run button) asks first.
 * Values go with the run request only: they are never saved, and secret-sounding names are entered masked.
 */
import { api } from './api.js';
import { h, uid } from './dom.js';
import { openModal } from '../ui/modal.js';

export interface NeededVariable {
  name: string;
  secret: boolean;
  journeys: string[];
}

export async function neededVariables(journeys: string[], tags: string[] = []): Promise<NeededVariable[]> {
  return (await api.post<{ variables: NeededVariable[] }>('/api/runs/needs', { journeys, tags })).variables;
}

/** One labelled input per variable; `value` keeps what was typed across re-renders. */
export function variableField(v: NeededVariable, value = ''): { el: HTMLElement; input: HTMLInputElement } {
  const id = uid(`var-${v.name}`);
  const input = h('input', {
    id,
    class: 'input',
    name: `var-${v.name}`,
    type: v.secret ? 'password' : 'text',
    value,
    autocomplete: v.secret ? 'new-password' : 'off',
    spellcheck: 'false',
    'data-var': v.name,
  });
  const el = h('div', { class: 'field' }, h('label', { for: id, text: v.name }), input, h('p', { class: 'help', text: `Used by ${v.journeys.join(', ')}${v.secret ? ' · masked in results' : ''}` }));
  return { el, input };
}

/** Asks for the variables `journeys` need; resolves with the values, `{}` when none are needed, undefined on cancel. */
export async function askVariables(journeys: string[]): Promise<Record<string, string> | undefined> {
  const needed = await neededVariables(journeys).catch(() => [] as NeededVariable[]);
  if (!needed.length) return {};
  const fields = needed.map((v) => variableField(v));
  const err = h('p', { class: 'field-error', role: 'alert' });
  const submit = () => {
    const empty = fields.filter((f) => !f.input.value).map((f) => f.input.dataset.var);
    err.textContent = empty.length ? `Enter a value for ${empty.join(', ')}` : '';
    return empty.length ? undefined : Object.fromEntries(fields.map((f) => [f.input.dataset.var!, f.input.value]));
  };
  return openModal<Record<string, string> | false>({
    title: 'Values for this run',
    size: 'sm',
    body: h('div', null, h('p', { class: 'help', text: 'The journey uses these values and the project does not set them. They are used for this run only and not saved.' }), ...fields.map((f) => f.el), err),
    actions: [
      { label: 'Cancel', run: () => false },
      { label: 'Run', kind: 'primary', run: submit },
    ],
  }).result.then((v) => (v ? v : undefined));
}
