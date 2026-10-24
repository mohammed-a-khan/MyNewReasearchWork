/**
 * Gherkin keywords per spoken language, selected with a `# language: <code>`
 * header. EZTest's own table, written from the Gherkin language reference.
 *
 * Step keywords are listed without their trailing space. A keyword that ends
 * with an apostrophe (French "Lorsqu'") is followed directly by the step text;
 * every other keyword needs a space (or the end of the line) after it.
 */

export interface GherkinDialect {
  /** English name of the language. */
  name: string;
  /** Its own name for itself. */
  native: string;
  feature: string[];
  rule: string[];
  background: string[];
  scenario: string[];
  scenarioOutline: string[];
  examples: string[];
  given: string[];
  when: string[];
  then: string[];
  and: string[];
  but: string[];
}

/** `*` is a step keyword in every language. */
const STAR = '*';

export const DIALECTS: Record<string, GherkinDialect> = {
  en: {
    name: 'English', native: 'English',
    feature: ['Feature', 'Business Need', 'Ability'],
    rule: ['Rule'],
    background: ['Background'],
    scenario: ['Example', 'Scenario'],
    scenarioOutline: ['Scenario Outline', 'Scenario Template'],
    examples: ['Examples', 'Scenarios'],
    given: ['Given'], when: ['When'], then: ['Then'], and: ['And'], but: ['But'],
  },
  de: {
    name: 'German', native: 'Deutsch',
    feature: ['Funktionalität', 'Funktion'],
    rule: ['Rule', 'Regel'],
    background: ['Grundlage', 'Hintergrund', 'Voraussetzungen', 'Vorbedingungen'],
    scenario: ['Beispiel', 'Szenario'],
    scenarioOutline: ['Szenariogrundriss', 'Szenarien'],
    examples: ['Beispiele'],
    given: ['Angenommen', 'Gegeben sei', 'Gegeben seien'], when: ['Wenn'], then: ['Dann'], and: ['Und'], but: ['Aber'],
  },
  fr: {
    name: 'French', native: 'français',
    feature: ['Fonctionnalité'],
    rule: ['Règle'],
    background: ['Contexte'],
    scenario: ['Exemple', 'Scénario'],
    scenarioOutline: ['Plan du scénario', 'Plan du Scénario'],
    examples: ['Exemples'],
    given: [
      'Soit', 'Sachant que', "Sachant qu'", 'Sachant', 'Etant donné que', "Etant donné qu'", 'Etant donné', 'Etant donnée', 'Etant donnés', 'Etant données',
      'Étant donné que', "Étant donné qu'", 'Étant donné', 'Étant donnée', 'Étant donnés', 'Étant données',
    ],
    when: ['Quand', 'Lorsque', "Lorsqu'"],
    then: ['Alors', 'Donc'],
    and: ['Et que', "Et qu'", 'Et'],
    but: ['Mais que', "Mais qu'", 'Mais'],
  },
  es: {
    name: 'Spanish', native: 'español',
    feature: ['Característica', 'Necesidad del negocio', 'Requisito'],
    rule: ['Regla', 'Regla de negocio'],
    background: ['Antecedentes'],
    scenario: ['Ejemplo', 'Escenario'],
    scenarioOutline: ['Esquema del escenario'],
    examples: ['Ejemplos'],
    given: ['Dado', 'Dada', 'Dados', 'Dadas'], when: ['Cuando'], then: ['Entonces'], and: ['Y', 'E'], but: ['Pero'],
  },
  it: {
    name: 'Italian', native: 'italiano',
    feature: ['Funzionalità', 'Esigenza di Business', 'Abilità'],
    rule: ['Regola'],
    background: ['Contesto'],
    scenario: ['Esempio', 'Scenario'],
    scenarioOutline: ['Schema dello scenario'],
    examples: ['Esempi'],
    given: ['Dato', 'Data', 'Dati', 'Date'], when: ['Quando'], then: ['Allora'], and: ['E'], but: ['Ma'],
  },
  pt: {
    name: 'Portuguese', native: 'português',
    feature: ['Funcionalidade', 'Característica', 'Caracteristica'],
    rule: ['Regra'],
    background: ['Contexto', 'Cenário de Fundo', 'Cenario de Fundo', 'Fundo'],
    scenario: ['Exemplo', 'Cenário', 'Cenario'],
    scenarioOutline: ['Esquema do Cenário', 'Esquema do Cenario', 'Delineação do Cenário', 'Delineacao do Cenario'],
    examples: ['Exemplos', 'Cenários', 'Cenarios'],
    given: ['Dado', 'Dada', 'Dados', 'Dadas'], when: ['Quando'], then: ['Então', 'Entao'], and: ['E'], but: ['Mas'],
  },
  nl: {
    name: 'Dutch', native: 'Nederlands',
    feature: ['Functionaliteit'],
    rule: ['Regel'],
    background: ['Achtergrond'],
    scenario: ['Voorbeeld', 'Scenario'],
    scenarioOutline: ['Abstract Scenario'],
    examples: ['Voorbeelden'],
    given: ['Gegeven', 'Stel'], when: ['Als', 'Wanneer'], then: ['Dan'], and: ['En'], but: ['Maar'],
  },
  pl: {
    name: 'Polish', native: 'polski',
    feature: ['Właściwość', 'Funkcja', 'Aspekt', 'Potrzeba biznesowa'],
    rule: ['Zasada', 'Reguła'],
    background: ['Założenia'],
    scenario: ['Przykład', 'Scenariusz'],
    scenarioOutline: ['Szablon scenariusza'],
    examples: ['Przykłady'],
    given: ['Zakładając, że', 'Zakładając', 'Mając'], when: ['Jeżeli', 'Jeśli', 'Gdy', 'Kiedy'], then: ['Wtedy'], and: ['Oraz', 'I'], but: ['Ale'],
  },
  sv: {
    name: 'Swedish', native: 'Svenska',
    feature: ['Egenskap'],
    rule: ['Regel'],
    background: ['Bakgrund'],
    scenario: ['Scenario'],
    scenarioOutline: ['Abstrakt Scenario', 'Scenariomall'],
    examples: ['Exempel'],
    given: ['Givet'], when: ['När'], then: ['Så'], and: ['Och'], but: ['Men'],
  },
  ru: {
    name: 'Russian', native: 'русский',
    feature: ['Функция', 'Функциональность', 'Функционал', 'Свойство'],
    rule: ['Правило'],
    background: ['Предыстория', 'Контекст'],
    scenario: ['Пример', 'Сценарий'],
    scenarioOutline: ['Структура сценария', 'Шаблон сценария'],
    examples: ['Примеры'],
    given: ['Допустим', 'Дано', 'Пусть'], when: ['Когда', 'Если'], then: ['То', 'Затем', 'Тогда'], and: ['И', 'К тому же', 'Также'], but: ['Но', 'А', 'Иначе'],
  },
};

export type BlockKind = 'feature' | 'rule' | 'background' | 'scenario' | 'scenarioOutline' | 'examples';
/** How a step keyword reads: Given (context), When (action), Then (outcome), And/But (conjunction), `*` (unknown). */
export type KeywordType = 'context' | 'action' | 'outcome' | 'conjunction' | 'unknown';

const BLOCKS: BlockKind[] = ['feature', 'rule', 'background', 'scenarioOutline', 'scenario', 'examples'];

/** The keyword matchers of one dialect, longest first so "Scenario Outline" wins over "Scenario". */
export interface CompiledDialect {
  code: string;
  dialect: GherkinDialect;
  blocks: Array<{ kind: BlockKind; keyword: string }>;
  steps: Array<{ type: KeywordType; keyword: string }>;
}

const compiled = new Map<string, CompiledDialect>();

export function dialectFor(code: string): CompiledDialect | undefined {
  const hit = compiled.get(code);
  if (hit) return hit;
  const d = DIALECTS[code];
  if (!d) return undefined;
  const blocks = BLOCKS.flatMap((kind) => d[kind].map((keyword) => ({ kind, keyword })));
  blocks.sort((a, b) => b.keyword.length - a.keyword.length);
  const steps: CompiledDialect['steps'] = [
    ...d.given.map((keyword) => ({ type: 'context' as const, keyword })),
    ...d.when.map((keyword) => ({ type: 'action' as const, keyword })),
    ...d.then.map((keyword) => ({ type: 'outcome' as const, keyword })),
    ...d.and.map((keyword) => ({ type: 'conjunction' as const, keyword })),
    ...d.but.map((keyword) => ({ type: 'conjunction' as const, keyword })),
    { type: 'unknown', keyword: STAR },
  ];
  steps.sort((a, b) => b.keyword.length - a.keyword.length);
  const c = { code, dialect: d, blocks, steps };
  compiled.set(code, c);
  return c;
}

/** Language codes EZTest knows. */
export function languages(): string[] {
  return Object.keys(DIALECTS);
}

/** Every step keyword of a dialect, as written in features (for editor highlighting). */
export function stepKeywords(code = 'en'): string[] {
  return dialectFor(code)?.steps.map((s) => s.keyword) ?? [];
}
