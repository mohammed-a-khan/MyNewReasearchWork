import { describe, it } from '../../support/testkit.js';

it('not run', () => {
  throw new Error('should not run');
});
describe('group', () => {
  it.only('the only one', () => {});
  it('sibling not run', () => {
    throw new Error('should not run');
  });
});
