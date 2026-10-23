import { createServer } from 'node:net';
import { it } from '../../support/testkit.js';

it('leaves a server listening', async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
});
