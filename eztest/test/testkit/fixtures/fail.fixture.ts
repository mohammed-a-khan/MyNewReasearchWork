import { afterAll, beforeAll, describe, expect, it } from '../../support/testkit.js';

let attempts = 0;

describe('failures', () => {
  it('diff', () => {
    expect({ name: 'order', total: 10, lines: [1, 2] }).toEqual({ name: 'order', total: 11, lines: [1, 2] });
  });
  it('times out', async () => {
    await new Promise((r) => setTimeout(r, 1000));
  }, 100);
  it('skips itself', (ctx) => {
    ctx.skip();
  });
  it.skipIf(true)('skipIf', () => {});
  it.runIf(false)('runIf', () => {});
  it.todo('later');
  it.skip('skipped', () => {});
  it('passes on the second attempt', { retry: 2 }, () => {
    attempts++;
    expect(attempts).toBe(2);
  });
  it('soft failures fail the test at its end', () => {
    expect.soft(1).toBe(2);
    expect.soft('a').toBe('b');
  });
});

describe('broken beforeAll', () => {
  beforeAll(() => {
    throw new Error('setup exploded');
  });
  afterAll(() => {
    console.log('afterAll still ran');
  });
  it('is skipped', () => {});
});

describe.skip('skipped suite', () => {
  it('never runs', () => {
    throw new Error('ran');
  });
});

it('leaves an unhandled rejection', async () => {
  void Promise.reject(new Error('nobody caught me'));
  await new Promise((r) => setTimeout(r, 10));
});
