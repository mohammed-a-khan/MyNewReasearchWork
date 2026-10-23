/** Config for cross-browser runs and remote browsers: `browsers:`, `browser.connect`, credentials. */
import { describe, expect, it } from '../support/testkit.js';
import { normalizeRawConfig, validateConfig } from '../../src/config/index.js';
import { browserRunOptions, remoteConnectFromConfig } from '../../src/engine/browsers.js';

describe('browsers and browser.connect in config', () => {
  it('normalises browser: { name, connect } and validates endpoints', () => {
    const { config, warnings } = validateConfig(normalizeRawConfig({
      browser: { name: 'firefox', connect: { bidiEndpoint: 'ws://grid:9222', headers: { 'x-api-key': 'secret://env/GRID_KEY' } } },
    }));
    expect(warnings).toEqual([]);
    expect(config.browser).toBe('firefox');
    expect(config.browserConnect).toEqual({ bidiEndpoint: 'ws://grid:9222', headers: { 'x-api-key': 'secret://env/GRID_KEY' } });
    expect(() => validateConfig({ browserConnect: { headers: {} } })).toThrow(/exactly one of cdpEndpoint/);
    expect(() => validateConfig({ browserConnect: { cdpEndpoint: 'http://a', bidiEndpoint: 'ws://b' } })).toThrow(/exactly one of cdpEndpoint/);
    const m = validateConfig({ browsers: ['chromium', 'firefox', { name: 'msedge', connect: { cdpEndpoint: 'http://edge-host:9222' } }] }).config;
    expect(m.browsers).toHaveLength(3);
  });

  it('resolves secret:// headers and auth, masks them, and turns auth into a header or a query parameter', async () => {
    const secrets: Record<string, string> = { 'secret://env/TOKEN': 'tok-1', 'secret://env/PASS': 'pw-2', 'secret://env/KEY': 'key-3' };
    const masked: string[] = [];
    const resolve = async (ref: string) => secrets[ref];
    const bearer = await remoteConnectFromConfig({ cdpEndpoint: 'http://h:1', headers: { 'x-api-key': 'secret://env/KEY', 'x-team': 'qa' }, auth: { token: 'secret://env/TOKEN' } }, resolve, (s) => masked.push(s));
    expect(bearer).toEqual({ cdpEndpoint: 'http://h:1', headers: { 'x-api-key': 'key-3', 'x-team': 'qa', Authorization: 'Bearer tok-1' } });
    const basic = await remoteConnectFromConfig({ bidiEndpoint: 'ws://h:2', headers: {}, auth: { username: 'qa', password: 'secret://env/PASS' } }, resolve, (s) => masked.push(s));
    expect(basic.headers?.Authorization).toBe(`Basic ${Buffer.from('qa:pw-2').toString('base64')}`);
    const query = await remoteConnectFromConfig({ cdpEndpoint: 'wss://grid.example.com/cdp', headers: {}, auth: { token: 'secret://env/TOKEN', queryParam: 'token' } }, resolve, (s) => masked.push(s));
    expect(query.cdpEndpoint).toBe('wss://grid.example.com/cdp?token=tok-1');
    expect(query.headers).toBeUndefined();
    for (const s of ['tok-1', 'pw-2', 'key-3']) expect(masked).toContain(s);
    expect(masked).not.toContain('qa');
    const opts = await browserRunOptions({ browsers: ['chromium', { name: 'firefox', connect: { bidiEndpoint: 'ws://ff:9222', headers: { authorization: 'secret://env/TOKEN' } } }] }, resolve, () => undefined);
    expect(opts.browsers).toEqual(['chromium', { name: 'firefox', connect: { bidiEndpoint: 'ws://ff:9222', headers: { authorization: 'tok-1' } } }]);
  });
});
