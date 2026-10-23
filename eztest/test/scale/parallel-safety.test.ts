import { describe, expect, it } from '../support/testkit.js';
import { join } from 'node:path';
import { FingerprintStore } from '../../src/heal/index.js';
import { envToConfig } from '../../src/config/load.js';
import { tempDir } from '../runner/fixtures.js';

describe('parallel safety of shared project files', () => {
  it('two processes saving the fingerprint store keep each other\'s entries', async () => {
    const dir = await tempDir('fp-merge');
    const path = join(dir, 'fingerprints.json');
    const a = await FingerprintStore.open(path);
    const b = await FingerprintStore.open(path);
    a.setLastGood('j1', 's1', { strategy: 'css', value: '#a' });
    b.setLastGood('j2', 's1', { strategy: 'css', value: '#b' });
    await a.save();
    await b.save();
    const back = await FingerprintStore.open(path);
    expect(back.get('j1', 's1')?.lastGood?.value).toBe('#a');
    expect(back.get('j2', 's1')?.lastGood?.value).toBe('#b');
  });

  it('results-server and shard variables are not read as config keys; EZTEST_SERVER__URL still is', () => {
    expect(envToConfig({ EZTEST_SERVER_TOKEN: 't', EZTEST_SHARD: '1/2', EZTEST_SHARD_INDEX: '1', EZTEST_SERVER__URL: 'https://s.example' })).toEqual({ server: { url: 'https://s.example' } });
  });
});
