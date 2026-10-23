/** `App:` is shared by desktop (Electron) and native mobile journeys; both round-trip through .ez. */
import { describe, expect, it } from '../support/testkit.js';
import { journeyToEzScript, parseEzScript } from '../../src/intent/index.js';

describe('App: header routing', () => {
  it('App: electron goes to the desktop Electron launcher', () => {
    const j = parseEzScript('Journey: Desk\nApp: electron "apps/orders/main.js" --variant=renamed\nClick the "Place order" button\n');
    expect(j.electron).toEqual({ app: 'apps/orders/main.js', args: ['--variant=renamed'] });
    expect(j.app).toBeUndefined();
    expect(j.platform).toBeUndefined();
    expect(parseEzScript(journeyToEzScript(j)).electron).toEqual(j.electron);
  });

  it('any other App: value is the mobile app for Platform: android|ios', () => {
    const j = parseEzScript('Journey: Phone\nPlatform: android\nApp: "com.shop.app"\nTap the "Log in" button\n');
    expect(j).toMatchObject({ platform: 'android', app: 'com.shop.app' });
    expect(j.electron).toBeUndefined();
    expect(parseEzScript(journeyToEzScript(j))).toMatchObject({ platform: 'android', app: 'com.shop.app' });
  });

  it('Electron: is an alias, and App: electron needs a path', () => {
    expect(parseEzScript('Journey: D\nElectron: main.js\nPress Enter\n').electron).toEqual({ app: 'main.js' });
    expect(() => parseEzScript('Journey: D\nApp: electron\nPress Enter\n')).toThrow(/needs the app's main script/);
  });
});
