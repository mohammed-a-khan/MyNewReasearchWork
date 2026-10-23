/** Mobile phrasings, headers and native locators: parsing and .ez / YAML / JSON round trips. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '../support/testkit.js';
import { Journey } from '../../src/core/index.js';
import { describeTarget, INTENT_RULES, journeyToEzScript, loadJourneyFile, matchedRule, parseEzScript, parseIntent } from '../../src/intent/index.js';
import { MOBILE_RULES } from '../../src/intent/rules-mobile.js';
import { findersFor } from '../../src/mobile/index.js';

const ALL = `Journey: Every mobile phrasing
Platform: android
App: "com.shop.app"
Device: Pixel 8 (Android 15)
Capabilities: serial="emulator-5554", clearData=true, launch=false
Tap the "Login" button
Swipe up until "Settings" is visible
Scroll down until the "Help" item is visible at most 5 times
Swipe from 200, 700 to 200, 200
Tap at 120, 640
Long press the "Photo" image for 2 seconds
Long press the "Photo" image for 1500 ms
Pinch in on the Map
Pinch out on the Map
Zoom in
Rotate to landscape
Set the screen orientation to portrait
Press the device back button
Press the device home button
Go to the home screen
Put the app in the background for 3 seconds
Send the app to the background
Bring the app to the foreground
Activate the app "com.example.shop"
Close the app
Terminate the app "com.other.app"
Restart the app
Install the app "apps/shop.apk"
Uninstall the app "com.example.shop"
Open the deep link "shop://orders/42"
Switch to the web view
Switch to the web view "WEBVIEW_com.shop.app"
Switch to the native app
Push file "fixtures/a.jpg" to "/sdcard/a.jpg"
Pull file "/sdcard/a.jpg" from the device as pic
Grant the app permission "android.permission.CAMERA", "android.permission.RECORD_AUDIO"
Revoke the app permission "camera"
Turn on airplane mode
Turn off wifi
Turn on mobile data
Hide the keyboard
Shake the device
Lock the device for 2 seconds
Unlock the device
Open the notifications
Accept the system alert
Dismiss the permission dialog
Click id=com.shop:id/login
Tap ~login
Tap class=android.widget.Button
Tap predicate=label == "OK"
Tap the "Buy" button at accessibility id=buy or id=buyBtn
`;

describe('mobile grammar', () => {
  it('every mobile rule has the Mobile category and parses its own example', () => {
    expect(MOBILE_RULES.length).toBeGreaterThanOrEqual(25);
    for (const r of MOBILE_RULES) {
      expect(r.category).toBe('Mobile');
      expect(matchedRule(r.example)?.name, r.example).toBe(r.name);
    }
    expect(INTENT_RULES.filter((r) => r.category === 'Mobile')).toHaveLength(MOBILE_RULES.length);
  });

  it('parses the mobile steps into mobile operations', () => {
    expect(parseIntent('Swipe up until "Settings" is visible')).toMatchObject({ action: 'mobile', args: { op: 'swipeUntil', direction: 'up' }, target: { description: '"Settings"' } });
    // The web scroll-until phrasing keeps its action; on a device it runs as a swipe-until (finger up).
    expect(parseIntent('Scroll down until "Help" is visible at most 4 times')).toMatchObject({ action: 'scroll', args: { op: 'untilVisible', direction: 'down', max: 4 } });
    expect(parseIntent('Rotate to landscape')).toMatchObject({ action: 'mobile', args: { op: 'rotate', orientation: 'landscape' } });
    expect(parseIntent('Open the deep link "shop://x"')).toMatchObject({ action: 'mobile', value: 'shop://x', args: { op: 'deepLink' } });
    expect(parseIntent('Switch to the web view')).toMatchObject({ action: 'mobile', args: { op: 'context', context: 'webview' } });
    expect(parseIntent('Zoom in on the Map')).toMatchObject({ args: { op: 'pinch', direction: 'out' } });
    expect(parseIntent('Tap the "Login" button')).toMatchObject({ action: 'click', target: { locators: [{ strategy: 'role', value: 'button', name: 'Login' }, { strategy: 'text', value: 'Login' }] } });
    // Web phrasings keep their meaning ("Go back" is navigation; the app's own Back button is still clickable).
    expect(parseIntent('Go back')).toMatchObject({ action: 'navigate', args: { mode: 'back' } });
    expect(parseIntent('Press the Back button')).toMatchObject({ action: 'click' });
  });

  it('round-trips .ez -> Journey -> .ez -> Journey', () => {
    const j = parseEzScript(ALL);
    expect(j.platform).toBe('android');
    expect(j.app).toBe('com.shop.app');
    expect(j.capabilities).toEqual({ serial: 'emulator-5554', clearData: true, launch: false });
    expect(j.emulation).toEqual({ device: 'Pixel 8 (Android 15)' });
    const text = journeyToEzScript(j);
    expect(parseEzScript(text)).toEqual(j);
    // Canonical rendering of steps whose intent was rewritten (YAML/JSON-authored steps).
    // (The last step's multi-candidate target keeps its own intent: its description alone does not reproduce the locators.)
    const canonical = Journey.parse({ ...j, steps: j.steps.slice(0, -1).map((s) => ({ ...s, intent: 'x' })) });
    expect(parseEzScript(journeyToEzScript(canonical)).steps.map((s) => [s.action, s.args, s.value, s.target?.locators])).toEqual(j.steps.slice(0, -1).map((s) => [s.action, s.args, s.value, s.target?.locators]));
  });

  it('loads the YAML and JSON forms with platform, app, capabilities and mobile steps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ez-mgram-'));
    writeFileSync(join(dir, 'm.yaml'), `name: Yaml mobile
platform: ios
app: com.shop.ios
capabilities: { udid: SIM-1, clearData: true }
steps:
  - Tap the "Log in" button
  - action: mobile
    intent: Swipe up until the Settings row is visible
    target: the "Settings" row
    args: { op: swipeUntil, direction: up, max: 3 }
  - intent: Rotate to landscape
    expect: the screen contains "Orders"
`);
    const y = await loadJourneyFile(join(dir, 'm.yaml'));
    expect(y).toMatchObject({ platform: 'ios', app: 'com.shop.ios', capabilities: { udid: 'SIM-1', clearData: true } });
    expect(y.steps[1]).toMatchObject({ action: 'mobile', args: { op: 'swipeUntil', max: 3 } });
    expect(y.steps[2].postconditions).toEqual([{ type: 'pageContainsText', value: 'Orders' }]);
    writeFileSync(join(dir, 'm.json'), JSON.stringify(y));
    expect(await loadJourneyFile(join(dir, 'm.json'))).toEqual(y);
    expect(parseEzScript(journeyToEzScript(y))).toEqual(Journey.parse({ ...y, steps: parseEzScript(journeyToEzScript(y)).steps }));
    expect(() => parseEzScript('Journey: X\nPlatform: windows\nTap "A"\n')).toThrow(/Platform must be web, android or ios/);
  });

  it('maps native selectors and descriptions to agent finders per platform', () => {
    expect(describeTarget('accessibility id=Log in').locators).toEqual([{ strategy: 'accessibilityId', value: 'Log in' }]);
    expect(describeTarget('~cart').locators).toEqual([{ strategy: 'accessibilityId', value: 'cart' }]);
    expect(describeTarget('id=com.shop:id/login').locators).toEqual([{ strategy: 'id', value: 'com.shop:id/login' }]);
    expect(describeTarget('class=XCUIElementTypeButton').locators).toEqual([{ strategy: 'className', value: 'XCUIElementTypeButton' }]);
    const button = describeTarget('the "Log in" button').locators[0];
    expect(findersFor(button, 'android').map((f) => f.using)).toEqual(['accessibility id', 'text', 'xpath', 'xpath']);
    expect(findersFor(button, 'ios').map((f) => f.using)).toEqual(['accessibility id', 'predicate', 'xpath', 'xpath']);
    expect(findersFor(button, 'ios')[1].value).toBe('label == "Log in" OR name == "Log in" OR value == "Log in"');
    expect(findersFor(button, 'android')[2].value).toContain(`contains(local-name(),"Button")`);
    expect(findersFor({ strategy: 'testId', value: 'buy' }, 'android')).toEqual([{ using: 'accessibility id', value: 'buy' }, { using: 'id', value: 'buy' }]);
    expect(findersFor({ strategy: 'css', value: '#buy' }, 'android')).toEqual([{ using: 'id', value: 'buy' }, { using: 'accessibility id', value: 'buy' }]);
    expect(findersFor({ strategy: 'css', value: 'div.x' }, 'android')).toEqual([]);
    expect(findersFor(button, 'android', 'WEBVIEW_x')[0].using).toBe('xpath');
    expect(findersFor({ strategy: 'placeholder', value: 'Search' }, 'android', 'WEBVIEW_x')).toEqual([{ using: 'css', value: '[placeholder="Search"]' }]);
  });
});
