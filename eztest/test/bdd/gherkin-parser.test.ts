/**
 * EZTest's own Gherkin parser: every construct of the language reference,
 * error positions (line and column) and spoken languages.
 */
import { describe, expect, it } from '../support/testkit.js';
import { GherkinParseError, compilePickles, languages, parseGherkin, parseGherkinLenient, splitTableRow } from '../../src/bdd/index.js';
import type { Background, Rule, Scenario } from '../../src/bdd/index.js';

const FULL = `# a comment before everything
@billing @release-2
Feature: Invoices
  As a clerk I want invoices
  so that customers pay.

  # comment inside the description area
  Background: signed in
    Given I am on "/login"
    And I log in as "clerk"

  @smoke
  Scenario: Create an invoice
    This scenario has a description.
    When I create an invoice for "Acme"
    Then the total is 49.50
    But no email is sent
    * the audit log has 1 entry

  Scenario Outline: Discounts for <tier>
    Given a customer of tier "<tier>"
    When they buy <qty> items
    Then the discount is <pct>%

    @fast
    Examples: Common tiers
      | tier   | qty | pct |
      | gold   | 10  | 15  |
      | silver | 5   | 5   |

    @slow @wip
    Scenarios: Edge tiers
      | tier | qty | pct |
      | none | 0   | 0   |

  Rule: Credit notes
    Business rule text.

    Background:
      Given credit notes are enabled

    @credit
    Example: Refund
      Given the invoice:
        """json
        { "id": 1, "note": "uses \\"\\"\\" inside" }
        """
      And a table:
        | a \\| b | c\\\\d | new\\nline |
        | 1      | 2     | 3         |
      Then the refund is accepted

    Scenario Template: Template keyword
      Given step <x>
      Examples:
        | x |
        | 1 |
`;

describe('Gherkin parser: constructs', () => {
  const doc = parseGherkin(FULL, 'invoices.feature');
  const f = doc.feature!;

  it('reads the feature, its tags, description and comments', () => {
    expect(f.keyword).toBe('Feature');
    expect(f.name).toBe('Invoices');
    expect(f.tags.map((t) => t.name)).toEqual(['@billing', '@release-2']);
    expect(f.tags[1].location).toEqual({ line: 2, column: 10 });
    expect(f.description).toBe('As a clerk I want invoices\nso that customers pay.');
    expect(f.location).toEqual({ line: 3, column: 1 });
    expect(f.language).toBe('en');
    expect(doc.comments.map((c) => c.location.line)).toEqual([1, 7]);
  });

  it('reads the background and scenarios with every step keyword', () => {
    const bg = f.children[0] as Background;
    expect(bg.kind).toBe('background');
    expect(bg.name).toBe('signed in');
    expect(bg.steps.map((s) => [s.keyword, s.text])).toEqual([['Given', 'I am on "/login"'], ['And', 'I log in as "clerk"']]);
    const sc = f.children[1] as Scenario;
    expect(sc.name).toBe('Create an invoice');
    expect(sc.description).toBe('This scenario has a description.');
    expect(sc.tags.map((t) => t.name)).toEqual(['@smoke']);
    expect(sc.steps.map((s) => s.keywordType)).toEqual(['action', 'outcome', 'conjunction', 'unknown']);
    expect(sc.steps[3].keyword).toBe('*');
    expect(sc.steps[0].location).toEqual({ line: 15, column: 5 });
  });

  it('reads outlines with several tagged Examples blocks', () => {
    const o = f.children[2] as Scenario;
    expect(o.outline).toBe(true);
    expect(o.keyword).toBe('Scenario Outline');
    expect(o.examples.map((e) => [e.keyword, e.name, e.tags.map((t) => t.name)])).toEqual([
      ['Examples', 'Common tiers', ['@fast']],
      ['Scenarios', 'Edge tiers', ['@slow', '@wip']],
    ]);
    expect(o.examples[0].tableHeader!.cells.map((c) => c.value)).toEqual(['tier', 'qty', 'pct']);
    expect(o.examples[0].tableBody.map((r) => r.cells.map((c) => c.value))).toEqual([['gold', '10', '15'], ['silver', '5', '5']]);
    expect(o.examples[0].tableBody[0].cells[1].location).toEqual({ line: 28, column: 18 });
  });

  it('reads rules with their own background, doc strings with a media type and escaped tables', () => {
    const r = f.children[3] as Rule;
    expect(r.kind).toBe('rule');
    expect(r.name).toBe('Credit notes');
    expect(r.description).toBe('Business rule text.');
    expect(r.children[0].kind).toBe('background');
    const ex = r.children[1] as Scenario;
    expect(ex.keyword).toBe('Example');
    expect(ex.tags.map((t) => t.name)).toEqual(['@credit']);
    const doc = ex.steps[0].docString!;
    expect(doc.mediaType).toBe('json');
    expect(doc.delimiter).toBe('"""');
    expect(doc.content).toBe('{ "id": 1, "note": "uses \\"\\"\\" inside" }'.replace('\\"\\"\\"', '"""'));
    const t = ex.steps[1].dataTable!;
    expect(t.rows[0].cells.map((c) => c.value)).toEqual(['a | b', 'c\\d', 'new\nline']);
    const tpl = r.children[2] as Scenario;
    expect(tpl.keyword).toBe('Scenario Template');
    expect(tpl.outline).toBe(true);
  });

  it('strips the doc string indentation and keeps deeper indentation', () => {
    const d = parseGherkin('Feature: F\n  Scenario: S\n    Given text\n      ```\n      line 1\n        indented\n      ```\n', 'x.feature');
    const s = (d.feature!.children[0] as Scenario).steps[0];
    expect(s.docString!.content).toBe('line 1\n  indented');
    expect(s.docString!.delimiter).toBe('```');
    expect(s.docString!.mediaType).toBeUndefined();
  });

  it('accepts Examples under a plain Scenario, a file without a feature, a BOM and CRLF line ends', () => {
    const d = parseGherkin('﻿Feature: F\r\n  Scenario: S <n>\r\n    Given <n>\r\n    Examples:\r\n      | n |\r\n      | 1 |\r\n', 'x.feature');
    expect((d.feature!.children[0] as Scenario).outline).toBe(true);
    expect(parseGherkin('# only a comment\n\n', 'empty.feature').feature).toBeUndefined();
  });

  it('allows a trailing comment after tags', () => {
    const d = parseGherkin('@a @b #comment\nFeature: F\n', 'x.feature');
    expect(d.feature!.tags.map((t) => t.name)).toEqual(['@a', '@b']);
  });

  it('reads the EZTest extension Examples: from data', () => {
    const d = parseGherkin('Feature: F\n  Scenario Outline: O\n    Given <a>\n    Examples: from data "rows.xlsx" sheet "Gold" where tier = "gold"\n', 'x.feature');
    const ex = (d.feature!.children[0] as Scenario).examples[0];
    expect(ex.source).toEqual({ from: 'rows.xlsx', sheet: 'Gold', where: 'tier = "gold"' });
  });
});

describe('Gherkin compiler: pickles', () => {
  const { pickles, warnings } = compilePickles(parseGherkin(FULL, 'invoices.feature'));

  it('expands outlines per row with values in names, steps and tags', () => {
    expect(pickles.map((p) => p.name)).toEqual(['Create an invoice', 'Discounts for gold', 'Discounts for silver', 'Discounts for none', 'Refund', 'Template keyword']);
    const gold = pickles[1];
    expect(gold.steps.map((s) => s.text)).toEqual(['I am on "/login"', 'I log in as "clerk"', 'a customer of tier "gold"', 'they buy 10 items', 'the discount is 15%']);
    expect(gold.tags).toEqual(['@billing', '@release-2', '@fast']);
    expect(pickles[3].tags).toEqual(['@billing', '@release-2', '@slow', '@wip']);
    expect(gold.examples?.row?.values).toEqual({ tier: 'gold', qty: '10', pct: '15' });
    expect(warnings).toEqual([]);
  });

  it('puts the feature background, then the rule background, before the steps; And/But take the type before', () => {
    const refund = pickles[4];
    expect(refund.rule?.name).toBe('Credit notes');
    expect(refund.steps.map((s) => [s.text, s.background ?? false])).toEqual([
      ['I am on "/login"', true], ['I log in as "clerk"', true], ['credit notes are enabled', true], ['the invoice:', false], ['a table:', false], ['the refund is accepted', false],
    ]);
    expect(refund.tags).toEqual(['@billing', '@release-2', '@credit']);
    expect(pickles[0].steps.map((s) => s.type)).toEqual(['context', 'context', 'action', 'outcome', 'outcome', 'outcome']);
    expect(refund.steps[3].docString?.mediaType).toBe('json');
    expect(refund.steps[4].dataTable?.[1]).toEqual(['1', '2', '3']);
  });

  it('warns about an outline without rows', () => {
    const r = compilePickles(parseGherkin('Feature: F\n  Scenario Outline: O\n    Given x\n', 'x.feature'));
    expect(r.pickles).toEqual([]);
    expect(r.warnings[0].message).toMatch(/without Examples/);
  });
});

describe('Gherkin parser: errors carry line and column', () => {
  const issues = (text: string) => parseGherkinLenient(text, 'bad.feature').issues;

  it('a step outside a scenario', () => {
    expect(issues('Feature: F\n  Given a step\n')).toEqual([{ line: 2, column: 3, message: expect.stringMatching(/inside a Scenario or a Background/) }]);
  });

  it('text before the Feature line', () => {
    expect(issues('hello\nFeature: F\n')[0]).toEqual({ line: 1, column: 1, message: expect.stringMatching(/expected a "Feature:" line/) });
  });

  it('an unclosed doc string', () => {
    expect(issues('Feature: F\n  Scenario: S\n    Given x\n      """\n      text\n')[0]).toMatchObject({ line: 4, column: 7, message: expect.stringMatching(/not closed/) });
  });

  it('inconsistent table cells and an unterminated row', () => {
    const i = issues('Feature: F\n  Scenario: S\n    Given x\n      | a | b |\n      | 1 |\n      | 2 | 3\n');
    expect(i[0]).toMatchObject({ line: 5, column: 7, message: expect.stringMatching(/inconsistent cell count/) });
    expect(i.find((x) => /must end with/.test(x.message))).toMatchObject({ line: 6, column: 13 });
  });

  it('free text after steps, tags on a background, a second background, a bad tag', () => {
    const i = issues('Feature: F\n  Background:\n    Given a\n  @t\n  Background:\n  Scenario: S\n    Given b\n    oops\n  @ok bad\n  Scenario: T\n');
    expect(i.map((x) => [x.line, x.column])).toEqual([[4, 3], [5, 3], [8, 5], [9, 7]]);
    expect(i[0].message).toMatch(/not allowed on a Background/);
    expect(i[1].message).toMatch(/only one Background/);
    expect(i[2].message).toMatch(/unexpected text "oops"/);
    expect(i[3].message).toMatch(/"bad" is not a tag/);
  });

  it('Examples without a table, a table without a header and steps after Examples', () => {
    const i = issues('Feature: F\n  Scenario Outline: O\n    Given <a>\n    Examples:\n    Given more\n');
    expect(i.map((x) => [x.line, x.message.slice(0, 22)])).toEqual([[4, '"Examples:" has no tab'], [5, 'steps cannot follow Ex']]);
  });

  it('a doc string and a table on one step, a table without a step', () => {
    const i = issues('Feature: F\n  Scenario: S\n    | a |\n    Given x\n      """\n      d\n      """\n      | b |\n');
    expect(i.map((x) => x.line)).toEqual([3, 8]);
  });

  it('throws GherkinParseError with every problem, and an unknown language', () => {
    let err: unknown;
    try {
      parseGherkin('# language: xx\nFeature: F\n  Given x\n', 'bad.feature');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GherkinParseError);
    const g = err as GherkinParseError;
    expect(g.issues.length).toBe(2);
    expect(g.line).toBe(1);
    expect(g.message).toMatch(/^bad\.feature:1:1: unknown language "xx"/);
    expect(g.message).toMatch(/bad\.feature:3:3:/);
  });
});

describe('Gherkin parser: spoken languages', () => {
  it('knows English and at least nine other languages', () => {
    expect(languages()).toEqual(expect.arrayContaining(['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'sv', 'ru']));
  });

  it('German', () => {
    const d = parseGherkin('# language: de\nFunktionalität: Anmeldung\n  Grundlage:\n    Angenommen ich bin auf "/login"\n  Szenariogrundriss: Rollen\n    Wenn ich mich als "<rolle>" anmelde\n    Dann sehe ich "Willkommen"\n    Aber nicht "Fehler"\n    Beispiele:\n      | rolle |\n      | admin |\n', 'de.feature');
    expect(d.feature!.language).toBe('de');
    expect(d.feature!.name).toBe('Anmeldung');
    const [p] = compilePickles(d).pickles;
    expect(p.steps.map((s) => [s.keyword, s.type])).toEqual([['Angenommen', 'context'], ['Wenn', 'action'], ['Dann', 'outcome'], ['Aber', 'outcome']]);
    expect(p.steps[1].text).toBe('ich mich als "admin" anmelde');
  });

  it('French, with keywords ending in an apostrophe', () => {
    const d = parseGherkin("# language: fr\nFonctionnalité: Panier\n  Scénario: Ajout\n    Étant donné que le panier est vide\n    Lorsqu'on ajoute un article\n    Alors le total est 10\n    Et qu'il y a 1 article\n", 'fr.feature');
    const [p] = compilePickles(d).pickles;
    expect(p.steps.map((s) => [s.keyword, s.text])).toEqual([
      ['Étant donné que', 'le panier est vide'], ["Lorsqu'", 'on ajoute un article'], ['Alors', 'le total est 10'], ["Et qu'", 'il y a 1 article'],
    ]);
  });

  it('Spanish, Portuguese, Dutch and Russian', () => {
    const es = compilePickles(parseGherkin('# language: es\nCaracterística: F\n  Escenario: S\n    Dado un paso\n    Cuando otro\n    Entonces fin\n', 'es.feature')).pickles[0];
    expect(es.steps.map((s) => s.type)).toEqual(['context', 'action', 'outcome']);
    const pt = compilePickles(parseGherkin('# language: pt\nFuncionalidade: F\n  Cenário: S\n    Dado um passo\n    Quando outro\n    Então fim\n', 'pt.feature')).pickles[0];
    expect(pt.steps.map((s) => s.keyword)).toEqual(['Dado', 'Quando', 'Então']);
    const nl = compilePickles(parseGherkin('# language: nl\nFunctionaliteit: F\n  Scenario: S\n    Gegeven een stap\n    Als iets\n    Dan klaar\n    En nog\n', 'nl.feature')).pickles[0];
    expect(nl.steps.map((s) => s.type)).toEqual(['context', 'action', 'outcome', 'outcome']);
    const ru = compilePickles(parseGherkin('# language: ru\nФункция: Вход\n  Сценарий: Успех\n    Допустим я на странице\n    Когда я вхожу\n    Тогда я вижу "Привет"\n', 'ru.feature')).pickles[0];
    expect(ru.steps.map((s) => s.keyword)).toEqual(['Допустим', 'Когда', 'Тогда']);
    expect(ru.feature.name).toBe('Вход');
  });

  it('the default language can be set for files without a header', () => {
    const d = parseGherkin('Egenskap: F\n  Scenario: S\n    Givet x\n    När y\n    Så z\n', 'sv.feature', { language: 'sv' });
    expect(compilePickles(d).pickles[0].steps.map((s) => s.type)).toEqual(['context', 'action', 'outcome']);
  });

  it('English keywords are not steps in another language', () => {
    expect(parseGherkinLenient('# language: de\nFunktionalität: F\n  Szenario: S\n    Angenommen a\n    Given x\n', 'de.feature').issues[0]).toMatchObject({ line: 5, message: expect.stringMatching(/unexpected text "Given x"/) });
  });
});

describe('table rows', () => {
  it('splits cells with escapes and reports columns', () => {
    const r = splitTableRow('  | a |  b\\|c | \\\\ |', 7);
    expect(r.cells.map((c) => [c.value, c.location.column])).toEqual([['a', 5], ['b|c', 10], ['\\', 17]]);
    expect(r.error).toBeUndefined();
  });
});
