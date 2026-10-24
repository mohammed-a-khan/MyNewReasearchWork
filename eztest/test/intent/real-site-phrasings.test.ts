/** Phrasings testers wrote for the public practice sites (test/acceptance/web) that the grammar had to learn. */
import { describe, expect, it } from '../support/testkit.js';
import { conditionToText, parseCondition } from '../../src/intent/index.js';

describe('where the user ended up', () => {
  it('checks the address when it is an address, and the page text when it is a screen name', () => {
    expect(parseCondition('user is redirected to "/login"')).toEqual({ type: 'urlContains', value: '/login' });
    expect(parseCondition('I land on "https://shop.test/cart"')).toEqual({ type: 'urlContains', value: 'https://shop.test/cart' });
    expect(parseCondition('user is redirected to Login')).toEqual({ type: 'pageContainsText', value: 'Login' });
    expect(parseCondition('I am on the "Orders" page')).toEqual({ type: 'pageContainsText', value: 'Orders' });
    const back = parseCondition(conditionToText(parseCondition('user is redirected to "/login"')));
    expect(back).toEqual({ type: 'urlContains', value: '/login' });
  });
});
