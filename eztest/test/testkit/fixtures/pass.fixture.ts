import { appendFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '../../support/testkit.js';
import { which } from './swap/real.js';

const log = (s: string) => process.env.TESTKIT_LOG && appendFileSync(process.env.TESTKIT_LOG, `${s}\n`);

beforeAll(() => {
  log('beforeAll file');
  return () => log('beforeAll file cleanup');
});
afterAll(() => log('afterAll file'));
beforeEach(() => log('beforeEach file'));
afterEach(() => log('afterEach file 1'));
afterEach(() => log('afterEach file 2'));

describe('outer', () => {
  beforeEach(() => {
    log('beforeEach outer');
    return () => log('beforeEach outer cleanup');
  });
  afterEach(() => log('afterEach outer'));
  it('first', () => {
    log('test first');
    expect(lateValue).toBe(42);
  });
  describe('inner', () => {
    beforeAll(() => log('beforeAll inner'));
    afterAll(() => log('afterAll inner'));
    it('second', async () => {
      log('test second');
      await new Promise((r) => setTimeout(r, 5));
    });
  });
});

it.each([
  { lib: 'kendo', n: 1 },
  { lib: 'aria', n: 2 },
])('$lib has n=$n', ({ n }) => {
  expect(n).toBeGreaterThan(0);
});
it.each([[1, 2, 3]])('%i + %i = %i', (a, b, sum) => {
  expect(a + b).toBe(sum);
});

it('sees config env, __dirname, require and the module swap', () => {
  expect(process.env.TESTKIT_FIXTURE_ENV).toBe('from-config');
  expect(__dirname.endsWith('fixtures')).toBe(true);
  expect(require('node:path').basename(__filename)).toBe('pass.fixture.ts');
  expect(which).toBe(process.env.TESTKIT_SWAP ? 'fake' : 'real');
});

describe('timeouts', { timeout: 500 }, () => {
  it('a describe-level timeout applies to its tests', async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  it('a per-test timeout overrides the default', async () => {
    await new Promise((r) => setTimeout(r, 2500));
  }, 4000);
});

// Declared after the describe() that reads it: describe bodies run after the module is evaluated.
const lateValue = 42;
