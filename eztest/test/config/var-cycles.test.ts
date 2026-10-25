/**
 * Config variables that refer to themselves or to each other (docs/configuration.md, "Values").
 *
 * `vars: { X: ${X:-https://...} }` left `baseUrl: ${X}` as `${X:-https://...}` and the run stopped with a bare
 * "baseUrl: Invalid URL". A variable's own name is the environment's variable (else the default); a cycle with no
 * way out is a configuration error that names the cycle.
 */
import { describe, expect, it } from '../support/testkit.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../../src/config/index.js';
import { varCycle } from '../../src/config/load.js';
import { tempDir } from '../runner/fixtures.js';

async function load(yaml: string, environment: Record<string, string> = {}) {
  const dir = await tempDir('var-cycles');
  await writeFile(join(dir, 'eztest.config.yaml'), yaml);
  return loadConfig({ cwd: dir, environment });
}

const SELF = 'baseUrl: ${THE_INTERNET_URL}\nvars:\n  THE_INTERNET_URL: ${THE_INTERNET_URL:-https://the-internet.herokuapp.com}\n';

describe('config variables that refer to themselves', () => {
  it('X: ${X:-default} is the environment\'s X, else the default', async () => {
    const plain = await load(SELF);
    expect(plain.config.baseUrl).toBe('https://the-internet.herokuapp.com');
    expect(plain.config.vars.THE_INTERNET_URL).toBe('https://the-internet.herokuapp.com');
    const fromEnv = await load(SELF, { THE_INTERNET_URL: 'http://localhost:7080' });
    expect(fromEnv.config.baseUrl).toBe('http://localhost:7080');
  });

  it('a variable that is only itself, or variables that refer to each other, stop with the cycle named', async () => {
    const self = await load('baseUrl: ${APP}\nvars:\n  APP: ${APP}/web\n').catch((e: unknown) => e);
    expect(self).toBeInstanceOf(ConfigError);
    expect((self as ConfigError).issues).toEqual([expect.stringMatching(/^vars\.APP: refers to itself and nothing gives it a value: set APP in the environment or \.env, or give the reference a default/)]);
    const loop = await load('baseUrl: ${A}\nvars:\n  A: ${B}/a\n  B: ${C:-x}/b\n  C: ${A}\n').catch((e: unknown) => e);
    expect((loop as ConfigError).issues).toEqual([expect.stringMatching(/^vars\.A: the variables refer to each other in a cycle \(A -> B -> C -> A\)/)]);
    expect(String((loop as ConfigError).message) + (loop as ConfigError).issues.join(' ')).not.toMatch(/Invalid URL/);
    // The environment breaks the cycle: its value is the variable's.
    expect((await load('baseUrl: ${A}\nvars:\n  A: ${B}\n  B: ${A}\n', { B: 'https://b.test' })).config.baseUrl).toBe('https://b.test');
  });

  it('varCycle: escapes, unknown names and defaults of unknown names are not cycles', () => {
    expect(varCycle({ A: '$${A}', B: '${NOPE}', C: '${NOPE:-x}', D: '${D:-d}' })).toBeUndefined();
    expect(varCycle({ A: '${A}' })).toEqual(['A', 'A']);
    expect(varCycle({ A: '${B}', B: '${A}' }, { A: 'x' })).toBeUndefined();
  });
});
