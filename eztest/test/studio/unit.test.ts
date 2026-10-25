/** Studio building blocks: path confinement, multi-error validation, grammar and templates. */
import { describe, expect, it } from '../support/testkit.js';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confinePath, confineJourneyPath, validateEz, grammar, journeyTemplate, convertText, PathError } from '../../src/studio/index.js';
import { hostAllowed, originAllowed, allowedHostnames, isSensitive, tokenMatches } from '../../src/studio/security.js';

describe('path confinement', () => {
  it('allows project paths and rejects escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-unit-'));
    const other = await mkdtemp(join(tmpdir(), 'studio-other-'));
    await mkdir(join(root, 'journeys'));
    await symlink(other, join(root, 'journeys', 'out'));
    expect(confinePath(root, 'journeys/a.ez')).toMatch(/journeys[\\/]a\.ez$/);
    expect(confinePath(root, 'journeys/new/dir/b.ez')).toMatch(/b\.ez$/);
    for (const p of ['../x', 'journeys/../../x', '/etc/passwd', 'C:\\\\x', 'journeys/out/x.ez', 'a\0b']) {
      expect(() => confinePath(root, p), p).toThrow(PathError);
    }
    expect(() => confineJourneyPath(root, 'journeys/a.txt')).toThrow(/Only journey files/);
    expect(() => confineJourneyPath(root, 'eztest.config.yaml')).toThrow(PathError);
    expect(() => confineJourneyPath(root, 'out/x.ez', { outputDir: 'out' })).toThrow(/read-only/);
    await writeFile(join(root, 'journeys', 'ok.yaml'), 'x');
    expect(confineJourneyPath(root, 'journeys/ok.yaml')).toMatch(/ok\.yaml$/);
  });

  it('marks secrets and hidden folders as sensitive', () => {
    for (const p of ['.env', '.env.prod', 'keys/server.pem', 'id_rsa', '.git/config', 'node_modules/x/a.json', '.eztest/history.json', 'a/.hidden/b.ez']) expect(isSensitive(p), p).toBe(true);
    for (const p of ['journeys/a.ez', 'legacy/login.feature']) expect(isSensitive(p), p).toBe(false);
  });

  it('checks Host, Origin and tokens', () => {
    const names = allowedHostnames('127.0.0.1');
    const req = (headers: Record<string, string>) => ({ headers }) as never;
    expect(hostAllowed(req({ host: '127.0.0.1:5000' }), names, 5000)).toBe(true);
    expect(hostAllowed(req({ host: 'localhost:5000' }), names, 5000)).toBe(true);
    expect(hostAllowed(req({ host: 'rebind.evil:5000' }), names, 5000)).toBe(false);
    expect(hostAllowed(req({}), names, 5000)).toBe(false);
    expect(originAllowed(req({ origin: 'http://localhost:5000' }), names, 5000)).toBe(true);
    expect(originAllowed(req({ origin: 'https://localhost:5000' }), names, 5000)).toBe(false);
    expect(originAllowed(req({ origin: 'http://localhost:5001' }), names, 5000)).toBe(false);
    expect(tokenMatches('a'.repeat(64), 'a'.repeat(64))).toBe(true);
    expect(tokenMatches('a'.repeat(64), 'a'.repeat(63))).toBe(false);
    expect(tokenMatches('a'.repeat(64), undefined)).toBe(false);
  });
});

describe('authoring helpers', () => {
  it('reports every bad line with its number', () => {
    const r = validateEz('Journey: J\nOpne /\nClick the "Go" button\nTyp "x" into the Name field\n');
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.line)).toEqual([2, 4]);
    expect(r.errors[0].suggestions).toContain('Open /login');
    expect(validateEz('Opne /').errors.at(-1)?.message).toMatch(/Journey/);
  });

  it('offers only phrasings the grammar accepts', () => {
    for (const g of grammar()) {
      if (g.kind === 'header') continue;
      for (const ex of g.examples) {
        // A block opener ("In a transaction on clinic") is offered as the first line of a block with a step, closed by End.
        const alone = validateEz(`Journey: J\nOpen /\n${ex.text}\n`).ok;
        expect(alone || validateEz(`Journey: J\nOpen /\n${ex.text}\nRun query "SELECT 1" on clinic as r\nEnd\n`).ok, ex.text).toBe(true);
      }
    }
  });

  it('creates valid templates in every format', () => {
    for (const f of ['ez', 'yaml', 'json'] as const) {
      const t = journeyTemplate('My new journey', f);
      expect(convertText(t, f, 'ez')).toMatch(/Journey: My new journey/);
    }
  });
});
