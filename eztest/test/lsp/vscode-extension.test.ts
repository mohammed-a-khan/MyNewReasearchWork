/**
 * The VS Code extension (editors/vscode): the TextMate grammar tokenizes .ez
 * lines with the expected scopes (real Oniguruma engine), the manifest and
 * the code agree on commands, and the extension packages into a .vsix.
 * Tests that need the extension's own dependencies are skipped when
 * `npm install` has not been run in editors/vscode.
 */
import { describe, expect, it } from '../support/testkit.js';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { readZip } from '../../src/runner/trace/zip.js';

const EXT = resolve(__dirname, '../../editors/vscode');
const hasDeps = existsSync(join(EXT, 'node_modules/vscode-textmate')) && existsSync(join(EXT, 'node_modules/@vscode/vsce'));
const manifest = JSON.parse(readFileSync(join(EXT, 'package.json'), 'utf8')) as {
  main: string;
  contributes: { commands: Array<{ command: string }>; languages: Array<{ id: string; extensions: string[] }>; grammars: Array<{ path: string; scopeName: string }>; menus: Record<string, Array<{ command: string }>> };
};

describe('VS Code extension', () => {
  it('registers every contributed command in the extension code', () => {
    const code = readFileSync(join(EXT, 'src/extension.ts'), 'utf8');
    const contributed = manifest.contributes.commands.map((c) => c.command);
    expect(contributed).toEqual(['eztest.runJourney', 'eztest.debugJourney', 'eztest.validate', 'eztest.openStudio', 'eztest.restartServer']);
    for (const c of contributed) expect(code).toContain(`registerCommand('${c}'`);
    for (const list of Object.values(manifest.contributes.menus)) for (const m of list) expect(contributed).toContain(m.command);
    expect(manifest.contributes.languages[0]).toMatchObject({ id: 'ez', extensions: ['.ez'] });
    // The client starts the language server through the CLI and uses the Testing API.
    expect(code).toContain("'lsp'");
    expect(code).toContain('vscode.tests.createTestController');
    expect(code).toContain("sendRequest<JourneyInfo[]>('eztest/journeys'");
  });

  it.skipIf(!hasDeps)('tokenizes .ez lines with the TextMate grammar', async () => {
    const req = createRequire(join(EXT, 'package.json'));
    // Loaded from editors/vscode/node_modules (not a dependency of the package itself), so typed locally.
    interface Token { startIndex: number; endIndex: number; scopes: string[] }
    interface Grammar { tokenizeLine(line: string, state: unknown): { tokens: Token[]; ruleStack: unknown } }
    const tm = req('vscode-textmate') as {
      INITIAL: unknown;
      parseRawGrammar(text: string, path: string): unknown;
      Registry: new (o: { onigLib: Promise<unknown>; loadGrammar: (scope: string) => Promise<unknown> }) => { loadGrammar(scope: string): Promise<Grammar | null> };
    };
    const onig = req('vscode-oniguruma') as { loadWASM(data: ArrayBuffer): Promise<void>; OnigScanner: new (p: string[]) => unknown; OnigString: new (s: string) => unknown };
    const wasm = readFileSync(join(EXT, 'node_modules/vscode-oniguruma/release/onig.wasm'));
    await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
    const registry = new tm.Registry({
      onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new onig.OnigScanner(p), createOnigString: (s: string) => new onig.OnigString(s) }),
      loadGrammar: async () => tm.parseRawGrammar(readFileSync(join(EXT, manifest.contributes.grammars[0].path), 'utf8'), 'ez.tmLanguage.json'),
    });
    const grammar = (await registry.loadGrammar('source.ez'))!;
    const lines = [
      'Journey: Bob creates an order',
      'Tags: @smoke @orders',
      '# a comment',
      'Type "${user}" into the Username field',
      '  Expect the URL contains "/dashboard"',
      'If the "More" button is visible then',
      'Capture the text of testid=order-total as total [optional timeout=5s]',
      'End',
      '  | bob | "Builder#2" |',
    ];
    let state = tm.INITIAL;
    const scopesOf = (line: string): Array<[string, string]> => {
      const r = grammar.tokenizeLine(line, state);
      state = r.ruleStack;
      return r.tokens.map((t) => [line.slice(t.startIndex, t.endIndex), t.scopes[t.scopes.length - 1]]);
    };
    const all = lines.map(scopesOf);
    const find = (i: number, text: string) => all[i].find(([t]) => t === text)?.[1];
    expect(find(0, 'Journey')).toBe('keyword.other.header.ez');
    expect(find(0, 'Bob creates an order')).toBe('entity.name.section.journey.ez');
    expect(find(1, '@smoke')).toBe('entity.name.tag.ez');
    expect(all[2][0][1]).toBe('comment.line.number-sign.ez');
    expect(find(3, 'Type')).toBe('keyword.other.step.ez');
    expect(find(3, 'user')).toBe('variable.other.ez');
    expect(find(4, 'Expect')).toBe('keyword.control.expect.ez');
    expect(find(4, '/dashboard')).toBe('string.quoted.double.ez');
    expect(find(5, 'If')).toBe('keyword.control.flow.ez');
    expect(find(6, 'testid')).toBe('entity.other.attribute-name.locator.ez');
    expect(find(6, 'optional timeout=5s')).toBe('storage.modifier.annotation.ez');
    expect(find(7, 'End')).toBe('keyword.control.flow.ez');
    expect(find(8, '|')).toBe('punctuation.separator.table.ez');
  });

  it.skipIf(!hasDeps)('builds and packages a .vsix with vsce', () => {
    const r = spawnSync('npm', ['run', 'package'], { cwd: EXT, encoding: 'utf8', timeout: 180_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const entries = readZip(readFileSync(join(EXT, 'eztest-vscode.vsix')));
    const names = [...entries.keys()];
    expect(names).toEqual(expect.arrayContaining(['extension.vsixmanifest', 'extension/package.json', 'extension/dist/extension.js', 'extension/syntaxes/ez.tmLanguage.json', 'extension/language-configuration.json', 'extension/THIRD_PARTY_NOTICES.md']));
    expect(names.some((n) => n.startsWith('extension/src/') || n.startsWith('extension/node_modules/'))).toBe(false);
    const bundle = entries.get('extension/dist/extension.js')!.toString('utf8');
    expect(bundle).toContain('eztest/journeys');
    expect(bundle).toContain('LanguageClient');
  }, 200_000);
});
