import { it } from '../../support/testkit.js';
// @ts-expect-error -- the import fails on purpose: the file must be reported as failed to collect
import { missing } from './does-not-exist.js';

it('never collected', () => {
  void missing;
});
