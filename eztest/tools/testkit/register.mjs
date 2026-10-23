/**
 * `node --import ./tools/testkit/register.mjs`: installs the testkit's module hooks
 * (loader.mjs) in this process. Options come from TESTKIT_LOADER_OPTIONS (JSON,
 * set by the runner): { root, cacheDir, swaps: [{ from, to, except }] }.
 */
import { register } from 'node:module';

let data = {};
try {
  data = JSON.parse(process.env.TESTKIT_LOADER_OPTIONS ?? '{}');
} catch {
  data = {};
}
register(new URL('./loader.mjs', import.meta.url), { data });
