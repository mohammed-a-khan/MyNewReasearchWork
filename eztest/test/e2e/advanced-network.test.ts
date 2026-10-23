/** E2E (real Chromium): network control and observation, browser state and emulation. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { describeSteps, expectPasses, outDir, runEz } from './advanced-helpers.js';

/** The native suite on Firefox (EZTEST_BROWSER=firefox): tests that only make sense on Chromium skip, saying why. */
const onFirefox = process.env.EZTEST_BROWSER === 'firefox';
const chromiumOnly = (title: string, reason: string) => (onFirefox ? `${title} [skipped on Firefox: ${reason}]` : title);

let server: DemoServer;
beforeAll(async () => {
  server = await startDemoApp();
});
afterAll(async () => {
  await server.close();
});

describe('network', () => {
  it('mocks, delays, blocks, adds headers, unroutes and asserts requests, payloads, console and websockets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-mocks-'));
    await writeFile(join(dir, 'orders.json'), JSON.stringify([{ id: 9 }, { id: 8 }]));
    const { j } = await expectPasses(server.url, `Journey: Network
Open /lab/events
Mock GET /lab/api/orders with status 200 and body '[{"id":1}]'
Click the "Load orders" button
  Expect #orders has text "1 orders"
Stop mocking /lab/api/orders
Mock GET /lab/api/orders with body from file "orders.json" and header "x-mock" = "yes"
Click the "Load orders" button
  Expect #orders has text "2 orders"
Remove all mocks
Mock /lab/api/orders with status 500 and body "nope" and only 1 times
Click the "Load orders" button
  Expect #orders has text "Failed to load"
Click the "Load orders" button
  Expect #orders has text "3 orders"
Block requests to /lab/api/orders
Click the "Load orders" button
  Expect #orders has text "Failed to load"
Unblock /lab/api/orders
Delay /lab/api/orders by 300 ms
Set request header "x-tenant" to "acme" for /lab/api/*
Click the "Save order" button
Wait for the POST response to /lab/api/orders with status 201 and store it as saved
  Expect #saved has text "Saved #101"
  Expect a POST request was made to "/lab/api/orders" with body containing "Gadget" with header "x-trace" = "abc123"
  Expect a request was made to "/lab/api/orders" with header "x-tenant" = "acme"
  Expect no request was made to "/analytics"
Capture the requests to /lab/api/orders as calls
Click the "Log error" button
  Expect the console has errors containing "Boom"
Expect there are at most 3 console errors
Click the "Connect chat" button
  Expect #chat has text "pong"
  Expect a websocket message containing "pong" was received
Save the network traffic as HAR "events-flow"
Block images
`, { baseDir: dir });
    expect(j.ledger.saved).toMatchObject({ status: 201, body: { id: 101, qty: 2, product: 'Gadget' } });
    expect((j.ledger.calls as unknown[]).length).toBeGreaterThanOrEqual(5);
  });

  it('expect no console errors fails with the messages that were logged', async () => {
    const { j } = await runEz(server.url, `Journey: Console errors
Open /lab/events
Click the "Throw" button
Wait 300 ms
  Expect there are no console errors`, { conditionTimeoutMs: 800 });
    expect(j.status).toBe('failed');
    expect(j.steps[2].error?.message).toMatch(/Unhandled kaboom/);
  });

  it.skipIf(onFirefox)(chromiumOnly('goes offline and online, throttles (Chromium), and writes a masked HAR as evidence', 'the runner throttles through a CDP session'), async () => {
    const out = await outDir('har');
    const { j, run } = await expectPasses(server.url, `Journey: Offline
Open /lab/events
Go offline
Click the "Load orders" button
  Expect #orders has text "Failed to load"
Go online
Throttle the network to slow 3G
Click the "Load orders" button
  Expect #orders has text "3 orders"
Stop throttling
Save the network traffic as HAR "offline" for /lab/api/*
`, { outputDir: out, mask: (s) => s.split('Contoso').join('****') });
    const harRef = run.journeys[0].steps.at(-1)!.evidence[0];
    const manifest = (await readFile(join(out, run.runId, 'evidence-manifest.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; path: string });
    const har = JSON.parse(await readFile(join(out, run.runId, manifest.find((m) => m.id === harRef)!.path), 'utf8')) as { log: { entries: Array<{ request: { url: string }; response: { content: { text?: string } } }> } };
    expect(har.log.entries.length).toBeGreaterThan(0);
    expect(har.log.entries.every((e) => e.request.url.includes('/lab/api/'))).toBe(true);
    const texts = har.log.entries.map((e) => e.response.content.text ?? '').join('');
    expect(texts).toContain('****');
    expect(texts).not.toContain('Contoso');
    expect(describeSteps(j)).not.toContain('failed');
  });
});

describe('browser state', () => {
  it('sets, captures, asserts and deletes cookies and storage (captures are masked)', async () => {
    const { j } = await expectPasses(server.url, `Journey: State
Open /lab/state
Set cookie "theme" to "dark"
Set local storage "cart" to "[1,2]"
Set session storage "step" to "2"
Reload the page
  Expect #cookies contains "theme=dark"
  Expect #cart has text "[1,2]"
  Expect cookie "theme" is "dark"
  Expect local storage "cart" is "[1,2]"
  Expect session storage "step" exists
Capture cookie "theme" as theme
Capture local storage "cart" as cart
Capture local storage as everything
Capture all cookies as cookies
Click the "Accept cookies" button
  Expect cookie "consent" is "yes"
  Expect local storage "seen" is "true"
Delete cookie "theme"
  Expect cookie "theme" does not exist
Remove "cart" from local storage
  Expect local storage "cart" does not exist
Clear session storage
Clear the browser state
  Expect cookie "consent" does not exist
`, { mask: (s) => s.split('dark').join('****') });
    expect(j.ledger.theme).toBe('****');
    expect(j.ledger.cart).toBe('[1,2]');
    expect(j.ledger.everything).toEqual({ cart: '[1,2]' });
  });

  it('emulates devices, locale, timezone, color scheme, reduced motion, geolocation, permissions, viewport, user agent and offline at journey level', async () => {
    await expectPasses(server.url, `Journey: Journey-level emulation
Device: Pixel 7
Locale: de-DE
Timezone: Asia/Tokyo
Color scheme: dark
Reduced motion: reduce
Geolocation: 52.52, 13.40
Permissions: geolocation
Open /lab/state
  Expect #tz has text "Asia/Tokyo"
  Expect #locale has text "de-DE"
  Expect #scheme has text "dark"
  Expect #motion has text "reduce"
  Expect #ua contains "Pixel 7"
Click the "Locate me" button
  Expect #geo has text "52.52,13.40"
`);
  });

  it.skipIf(onFirefox)(chromiumOnly('changes emulation mid-journey (Chromium DevTools protocol), clipboard, headers and user agent', 'the runner changes emulation mid-journey through a CDP session'), async () => {
    await expectPasses(server.url, `Journey: Mid-journey emulation
Open /lab/state
Set the timezone to "Europe/Berlin"
Set the locale to fr-FR
Use dark mode
Prefer reduced motion
Set the user agent to "EZTestBot/1.0"
Resize the viewport to 800x600
Reload the page
  Expect #tz has text "Europe/Berlin"
  Expect #locale has text "fr-FR"
  Expect #scheme has text "dark"
  Expect #motion has text "reduce"
  Expect #ua has text "EZTestBot/1.0"
  Expect #vp has text "800x600"
Set the geolocation to 48.85, 2.35
Click the "Locate me" button
  Expect #geo has text "48.85,2.35"
Copy "SAVE-42" to the clipboard
Click the "Paste from clipboard" button
  Expect #pasted has text "SAVE-42"
Click the "Copy code" button
Capture the clipboard as copied
  Expect \${copied} equals "COPIED-123"
Send header "x-tenant" = "acme" with every request
Call API "GET /lab/api/echo" and store as echo
Emulate device "iPhone 13"
Reload the page
  Expect #ua contains "iPhone"
Grant permissions "notifications"
Revoke all permissions
Emulate print media
`);
  });

  it('uses HTTP basic auth (journey header and step)', async () => {
    await expectPasses(server.url, `Journey: Basic auth step
Use basic auth with username "admin" and password "s3cret"
Open /lab/basic
  Expect the page contains "Welcome, admin"
`);
    await expectPasses(server.url, `Journey: Basic auth header
Variables: pw=s3cret
HTTP credentials: admin / \${pw}
Open /lab/basic
  Expect the page contains "Welcome, admin"
`);
  });
});
