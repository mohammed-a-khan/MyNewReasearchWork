/** Config for the testkit's own fixture files (run by test/testkit/runner.test.ts). */
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default {
  include: ['**/*.fixture.ts'],
  testTimeout: 2000,
  hookTimeout: 2000,
  env: { TESTKIT_FIXTURE_ENV: 'from-config' },
  swaps: process.env.TESTKIT_SWAP ? [{ from: here('./swap/real.ts'), to: here('./swap/fake.ts'), except: [here('./swap/fake.ts')] }] : [],
};
