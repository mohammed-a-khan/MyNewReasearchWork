/**
 * Gherkin `.feature` files in the editor: syntax highlighting (block
 * keywords, step keywords, tags, comments, doc strings, tables, quoted text,
 * numbers, <placeholders>), the outline (scenarios and their steps) and step
 * completions from the project's step definitions and EZTest phrasings.
 *
 * The keyword lists match the server's language table (src/bdd/gherkin/languages.ts;
 * a unit test keeps them equal).
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { StreamLanguage, type StreamParser } from '@codemirror/language';
import { api } from '../../core/api.js';
import { grammar } from '../../core/state.js';
import type { OutlineItem } from './ezlang.js';

/** Feature, Rule, Background, Scenario, Scenario Outline and Examples keywords of every supported language. */
export const GHERKIN_BLOCK_KEYWORDS = [
  'Feature', 'Business Need', 'Ability', 'Rule', 'Background', 'Example', 'Scenario', 'Scenario Outline', 'Scenario Template', 'Examples', 'Scenarios',
  'Funktionalität', 'Funktion', 'Regel', 'Grundlage', 'Hintergrund', 'Voraussetzungen', 'Vorbedingungen', 'Beispiel', 'Szenario', 'Szenariogrundriss', 'Szenarien', 'Beispiele',
  'Fonctionnalité', 'Règle', 'Contexte', 'Exemple', 'Scénario', 'Plan du scénario', 'Plan du Scénario', 'Exemples',
  'Característica', 'Necesidad del negocio', 'Requisito', 'Regla', 'Regla de negocio', 'Antecedentes', 'Ejemplo', 'Escenario', 'Esquema del escenario', 'Ejemplos',
  'Funzionalità', 'Esigenza di Business', 'Abilità', 'Regola', 'Contesto', 'Esempio', 'Schema dello scenario', 'Esempi',
  'Funcionalidade', 'Caracteristica', 'Regra', 'Contexto', 'Cenário de Fundo', 'Cenario de Fundo', 'Fundo', 'Exemplo', 'Cenário', 'Cenario',
  'Esquema do Cenário', 'Esquema do Cenario', 'Delineação do Cenário', 'Delineacao do Cenario', 'Exemplos', 'Cenários', 'Cenarios',
  'Functionaliteit', 'Achtergrond', 'Voorbeeld', 'Abstract Scenario', 'Voorbeelden',
  'Właściwość', 'Funkcja', 'Aspekt', 'Potrzeba biznesowa', 'Zasada', 'Reguła', 'Założenia', 'Przykład', 'Scenariusz', 'Szablon scenariusza', 'Przykłady',
  'Egenskap', 'Bakgrund', 'Abstrakt Scenario', 'Scenariomall', 'Exempel',
  'Функция', 'Функциональность', 'Функционал', 'Свойство', 'Правило', 'Предыстория', 'Контекст', 'Пример', 'Сценарий', 'Структура сценария', 'Шаблон сценария', 'Примеры',
];

/** Given / When / Then / And / But keywords of every supported language (`*` too). */
export const GHERKIN_STEP_KEYWORDS = [
  'Given', 'When', 'Then', 'And', 'But',
  'Angenommen', 'Gegeben sei', 'Gegeben seien', 'Wenn', 'Dann', 'Und', 'Aber',
  'Soit', 'Sachant que', "Sachant qu'", 'Sachant', 'Etant donné que', "Etant donné qu'", 'Etant donné', 'Etant donnée', 'Etant donnés', 'Etant données',
  'Étant donné que', "Étant donné qu'", 'Étant donné', 'Étant donnée', 'Étant donnés', 'Étant données', 'Quand', 'Lorsque', "Lorsqu'", 'Alors', 'Donc',
  'Et que', "Et qu'", 'Et', 'Mais que', "Mais qu'", 'Mais',
  'Dado', 'Dada', 'Dados', 'Dadas', 'Cuando', 'Entonces', 'Y', 'E', 'Pero',
  'Dato', 'Data', 'Dati', 'Date', 'Quando', 'Allora', 'Ma',
  'Então', 'Entao', 'Mas',
  'Gegeven', 'Stel', 'Als', 'Wanneer', 'Dan', 'En', 'Maar',
  'Zakładając, że', 'Zakładając', 'Mając', 'Jeżeli', 'Jeśli', 'Gdy', 'Kiedy', 'Wtedy', 'Oraz', 'I', 'Ale',
  'Givet', 'När', 'Så', 'Och', 'Men',
  'Допустим', 'Дано', 'Пусть', 'Когда', 'Если', 'То', 'Затем', 'Тогда', 'И', 'К тому же', 'Также', 'Но', 'А', 'Иначе',
  '*',
];

const BLOCKS = [...new Set(GHERKIN_BLOCK_KEYWORDS)].sort((a, b) => b.length - a.length);
const STEPS = [...new Set(GHERKIN_STEP_KEYWORDS)].sort((a, b) => b.length - a.length);

export function blockKeyword(line: string): string | undefined {
  const t = line.trimStart();
  return BLOCKS.find((k) => t.startsWith(k) && t[k.length] === ':');
}

export function stepKeyword(line: string): string | undefined {
  const t = line.trimStart();
  return STEPS.find((k) => t.startsWith(k) && (t.length === k.length || /\s/.test(t[k.length]) || k.endsWith("'")));
}

interface GState {
  doc: string | null;
  /** After a block keyword: the rest of the line is the name. */
  name: boolean;
  table: boolean;
}

const parser: StreamParser<GState> = {
  name: 'gherkin',
  startState: () => ({ doc: null, name: false, table: false }),
  copyState: (s) => ({ ...s }),
  token(stream, st) {
    if (st.doc) {
      if (stream.sol() && stream.string.trim() === st.doc) {
        stream.skipToEnd();
        st.doc = null;
        return 'string.special';
      }
      stream.skipToEnd();
      return 'string';
    }
    if (stream.sol()) {
      st.name = false;
      st.table = false;
      stream.eatSpace();
      const rest = stream.string.slice(stream.pos);
      if (/^#\s*language\s*:/.test(rest)) {
        stream.skipToEnd();
        return 'meta';
      }
      if (rest.startsWith('#')) {
        stream.skipToEnd();
        return 'comment';
      }
      if (rest.startsWith('"""') || rest.startsWith('```')) {
        st.doc = rest.slice(0, 3);
        stream.skipToEnd();
        return 'string.special';
      }
      if (rest.startsWith('|')) st.table = true;
      const b = blockKeyword(rest);
      if (b) {
        stream.pos += b.length + 1;
        st.name = true;
        return 'heading';
      }
      const s = stepKeyword(rest);
      if (s) {
        stream.pos += s.length;
        return 'keyword';
      }
      if (rest.startsWith('@')) {
        stream.match(/^@\S+/);
        return 'labelName';
      }
    }
    if (stream.eatSpace()) return null;
    if (st.name) {
      stream.skipToEnd();
      return 'heading';
    }
    if (stream.peek() === '@' && stream.match(/^@\S+/)) return 'labelName';
    if (stream.peek() === '#' && /\s/.test(stream.string[stream.pos - 1] ?? ' ') && /^\s*@/.test(stream.string)) {
      stream.skipToEnd();
      return 'comment';
    }
    if (st.table && stream.eat('|')) return 'punctuation';
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string';
    if (stream.match(/^<[^<>\s][^<>]*>/)) return 'variableName';
    if (stream.match(/^\$\{[^}]*\}?/)) return 'variableName';
    if (stream.match(/^-?\d+(?:\.\d+)?\b/)) return 'number';
    if (!stream.match(/^[^\s"'<|@$\d-]+/)) stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '#' } },
};

export const gherkinLanguage = StreamLanguage.define(parser);

/** Scenarios (and Backgrounds, Rules, Examples) with their steps, by line, for the outline panel. */
export function featureOutline(text: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  let doc: string | null = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (doc) {
      if (t === doc) doc = null;
      return;
    }
    if (t.startsWith('"""') || t.startsWith('```')) {
      doc = t.slice(0, 3);
      return;
    }
    if (!t || t.startsWith('#') || t.startsWith('|') || t.startsWith('@')) return;
    if (blockKeyword(t)) out.push({ line: i + 1, text: t, kind: 'expect' });
    else if (stepKeyword(t)) out.push({ line: i + 1, text: t, kind: 'step' });
  });
  return out;
}

/** Step lines of feature text (where breakpoints go; the runner's step ids are L<line>). */
export function featureStepLines(text: string): number[] {
  return featureOutline(text).filter((x) => x.kind === 'step').map((x) => x.line);
}

interface Definitions {
  definitions: Array<{ keyword: string; pattern: string; file: string; line: number }>;
}

let defs: Promise<Definitions> | undefined;
let defsAt = 0;

function definitions(): Promise<Definitions> {
  if (!defs || Date.now() - defsAt > 10_000) {
    defsAt = Date.now();
    defs = api.get<Definitions>('/api/bdd/definitions').catch(() => ({ definitions: [] }));
  }
  return defs;
}

/** After a step keyword: the project's step definitions, then EZTest phrasings (they run without glue code). */
export async function featureCompletions(ctx: CompletionContext): Promise<CompletionResult | null> {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const kw = stepKeyword(before);
  if (!kw) return null;
  const lead = before.length - before.trimStart().length;
  const from = line.from + lead + kw.length + (before.slice(lead + kw.length).match(/^\s*/)?.[0].length ?? 0);
  if (from > ctx.pos) return null;
  const options: Completion[] = [];
  const seen = new Set<string>();
  for (const d of (await definitions()).definitions) {
    if (seen.has(d.pattern) || d.pattern.startsWith('/')) continue;
    seen.add(d.pattern);
    options.push({ label: d.pattern, detail: `${d.file}:${d.line}`, type: 'function', boost: 2 });
  }
  const outcome = /^(?:then|dann|alors|entonces|allora|então|entao|dan|wtedy|så|тогда|то)$/i.test(kw);
  for (const g of grammar.get()) {
    if (g.kind !== 'action' && g.kind !== 'expectation') continue;
    for (const ex of g.examples) {
      const label = g.kind === 'expectation' ? ex.text.replace(/^Expect\s+/, '') : `I ${ex.text.charAt(0).toLowerCase()}${ex.text.slice(1)}`;
      if (seen.has(label)) continue;
      seen.add(label);
      options.push({ label, detail: `EZTest: ${g.category}`, type: g.kind === 'expectation' ? 'variable' : 'keyword', boost: g.kind === 'expectation' && outcome ? 1 : 0 });
    }
  }
  return { from, options, validFor: /^[^\n]*$/ };
}
