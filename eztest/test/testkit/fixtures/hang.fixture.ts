import { it } from '../../support/testkit.js';

it('blocks the event loop', () => {
  for (;;) {
    // never returns: the runner's watchdog must kill the worker
  }
}, 100);
