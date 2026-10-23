/** Advanced phrasings: every phrasing parses deterministically, renders back to .ez and round-trips through YAML/JSON. */
import { describe, expect, it } from '../support/testkit.js';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { Journey, Step, type Condition, type StepInput } from '../../src/core/index.js';
import {
  CONDITION_RULES, INTENT_RULES, IntentParseError, journeyToEzScript, normalizeJourneyInput, parseCondition, parseEzScript, parseIntent, conditionToText,
} from '../../src/intent/index.js';

type Want = Partial<Record<keyof StepInput, unknown>>;

/** [line, expected subset of the parsed step]. Natural variants are listed next to each other. */
export const ACTION_CASES: Array<[string, Want]> = [
  // ---------------------------------------------------------------- tabs, windows, popups
  ['Click the "Open report" link and switch to the new tab', { action: 'click', args: { newPage: 'switch' } }],
  ['Click the "Open report" link and go to the newly opened window', { action: 'click', args: { newPage: 'switch' } }],
  ['Click the "Help" button and switch to the popup', { action: 'click', args: { newPage: 'switch' } }],
  ['Click the "Export" button and wait for the new tab', { action: 'click', args: { newPage: 'wait' } }],
  ['Open a new tab with /orders as orders', { action: 'tab', value: '/orders', args: { op: 'open', name: 'orders' } }],
  ['Open a new tab', { action: 'tab', args: { op: 'open' } }],
  ['Open /report in a new tab', { action: 'tab', value: '/report', args: { op: 'open' } }],
  ['Open "https://example.com/x" in a new window', { action: 'tab', value: 'https://example.com/x', args: { op: 'open' } }],
  ['Switch to the new tab', { action: 'tab', args: { op: 'switch', by: 'new' } }],
  ['Go to the newly opened window', { action: 'tab', args: { op: 'switch', by: 'new' } }],
  ['Switch to the popup', { action: 'tab', args: { op: 'switch', by: 'new' } }],
  ['Move to the new window', { action: 'tab', args: { op: 'switch', by: 'new' } }],
  ['Focus the new tab', { action: 'tab', args: { op: 'switch', by: 'new' } }],
  ['Switch to the latest tab', { action: 'tab', args: { op: 'switch', by: 'new' } }],
  ['Switch back to the main tab', { action: 'tab', args: { op: 'switch', by: 'main' } }],
  ['Go back to the original window', { action: 'tab', args: { op: 'switch', by: 'main' } }],
  ['Return to the first tab', { action: 'tab', args: { op: 'switch', by: 'main' } }],
  ['Switch back to the previous tab', { action: 'tab', args: { op: 'switch', by: 'previous' } }],
  ['Switch back', { action: 'tab', args: { op: 'switch', by: 'previous' } }],
  ['Switch to tab 2', { action: 'tab', args: { op: 'switch', by: 'index', value: '2' } }],
  ['Switch to the second tab', { action: 'tab', args: { op: 'switch', by: 'index', value: '2' } }],
  ['Go to window 3', { action: 'tab', args: { op: 'switch', by: 'index', value: '3' } }],
  ['Switch to the tab titled "Report"', { action: 'tab', args: { op: 'switch', by: 'title', value: 'Report' } }],
  ['Switch to the window with title "Report"', { action: 'tab', args: { op: 'switch', by: 'title', value: 'Report' } }],
  ['Switch to the "Report" tab', { action: 'tab', args: { op: 'switch', by: 'title', value: 'Report' } }],
  ['Switch to the tab with URL "/report"', { action: 'tab', args: { op: 'switch', by: 'url', value: '/report' } }],
  ['Switch to the window whose URL contains "/checkout"', { action: 'tab', args: { op: 'switch', by: 'url', value: '/checkout' } }],
  ['Close the tab', { action: 'tab', args: { op: 'close' } }],
  ['Close the popup', { action: 'tab', args: { op: 'close' } }],
  ['Close the current window', { action: 'tab', args: { op: 'close' } }],
  ['Close tab 2', { action: 'tab', args: { op: 'close', by: 'index', value: '2' } }],
  ['Close the "Report" tab', { action: 'tab', args: { op: 'close', by: 'title', value: 'Report' } }],
  // ---------------------------------------------------------------- frames
  ['Switch to frame "payment"', { action: 'frame', args: { op: 'enter', path: ['payment'] } }],
  ['Switch to the "payment" iframe', { action: 'frame', args: { op: 'enter', path: ['payment'] } }],
  ['Switch to frame "outer" > "inner"', { action: 'frame', args: { op: 'enter', path: ['outer', 'inner'] } }],
  ['Enter the "payment" frame', { action: 'frame', args: { op: 'enter', path: ['payment'] } }],
  ['Switch into frame #pay', { action: 'frame', args: { op: 'enter', path: ['#pay'] } }],
  ['Switch to the main frame', { action: 'frame', args: { op: 'main' } }],
  ['Switch back to the page', { action: 'frame', args: { op: 'main' } }],
  ['Leave the frame', { action: 'frame', args: { op: 'main' } }],
  ['Switch to the parent frame', { action: 'frame', args: { op: 'parent' } }],
  ['In the "payment" frame: type "4242" into the Card number field', { action: 'frame', args: { op: 'enter', path: ['payment'] }, steps: [expect.objectContaining({ action: 'fill', value: '4242' })] }],
  ['In the "inner" frame inside the "outer" frame: click the "OK" button', { action: 'frame', args: { op: 'enter', path: ['outer', 'inner'] } }],
  ['In frame "outer" > "inner": click the "OK" button', { action: 'frame', args: { op: 'enter', path: ['outer', 'inner'] } }],
  // ---------------------------------------------------------------- dialogs
  ['Accept the next dialog', { action: 'dialog', args: { op: 'accept' } }],
  ['Accept the next alert', { action: 'dialog', args: { op: 'accept' } }],
  ['Confirm the next confirmation dialog', { action: 'dialog', args: { op: 'accept', kind: 'confirm' } }],
  ['Accept the next dialog and store it as message', { action: 'dialog', args: { op: 'accept' }, captureAs: 'message' }],
  ['Dismiss the next dialog', { action: 'dialog', args: { op: 'dismiss' } }],
  ['Cancel the next confirm dialog', { action: 'dialog', args: { op: 'dismiss', kind: 'confirm' } }],
  ['Dismiss the confirm dialog', { action: 'dialog', args: { op: 'dismiss', kind: 'confirm' } }],
  ['Answer the next prompt with "Ada"', { action: 'dialog', value: 'Ada', args: { op: 'answer', kind: 'prompt' } }],
  ['Type "Ada" into the next prompt', { action: 'dialog', value: 'Ada', args: { op: 'answer' } }],
  ['Capture the dialog text as message', { action: 'query', captureAs: 'message', args: { what: 'dialog' } }],
  // ---------------------------------------------------------------- keyboard
  ['Press Control+Shift+K', { action: 'press', value: 'Control+Shift+K' }],
  ['Press Mod+S', { action: 'press', value: 'Mod+S' }],
  ['Press Ctrl+Alt+Del', { action: 'press', value: 'Ctrl+Alt+Del' }],
  ['Press PageDown', { action: 'press', value: 'PageDown' }],
  ['Press F12', { action: 'press', value: 'F12' }],
  ['Press Control+K on the page', { action: 'press', value: 'Control+K' }],
  ['Press Tab 3 times', { action: 'press', value: 'Tab', args: { times: 3 } }],
  ['Press Backspace 2 times in the Search field', { action: 'press', value: 'Backspace', args: { times: 2 }, target: expect.objectContaining({ description: 'the Search field' }) }],
  ['Use the keyboard shortcut Mod+K', { action: 'press', value: 'Mod+K' }],
  ['Hold down Shift', { action: 'keyboard', value: 'Shift', args: { op: 'down' } }],
  ['Press and hold Control', { action: 'keyboard', value: 'Control', args: { op: 'down' } }],
  ['Release Shift', { action: 'keyboard', value: 'Shift', args: { op: 'up' } }],
  ['Type "laptop" slowly into the Search field', { action: 'keyboard', value: 'laptop', args: { op: 'type', delayMs: 100 } }],
  ['Type "laptop" into the Search field slowly', { action: 'keyboard', value: 'laptop', args: { op: 'type', delayMs: 100 } }],
  ['Type "laptop" with a 250 ms delay into the Search field', { action: 'keyboard', value: 'laptop', args: { op: 'type', delayMs: 250 } }],
  ['Type "abc" character by character into the Search field', { action: 'keyboard', args: { op: 'type', delayMs: 100 } }],
  ['Type "hello" on the keyboard', { action: 'keyboard', value: 'hello', args: { op: 'type', delayMs: 0 } }],
  ['Insert text "Hello" into the Notes field', { action: 'keyboard', value: 'Hello', args: { op: 'insert' } }],
  // ---------------------------------------------------------------- mouse and gestures
  ['Open the context menu on the "Report.pdf" item', { action: 'click', args: { button: 'right' } }],
  ['Context-click the "Report.pdf" item', { action: 'click', args: { button: 'right' } }],
  ['Middle-click the "Docs" link', { action: 'click', args: { button: 'middle' } }],
  ['Click the "Docs" link with the middle mouse button', { action: 'click', args: { button: 'middle' } }],
  ['Triple-click the Address field', { action: 'click', args: { clickCount: 3 } }],
  ['Shift-click the "Row 3" cell', { action: 'click', args: { modifiers: ['shift'] } }],
  ['Ctrl+Shift-click the "Row 3" cell', { action: 'click', args: { modifiers: ['ctrl', 'shift'] } }],
  ['Cmd-click the "Docs" link', { action: 'click', args: { modifiers: ['cmd'] } }],
  ['Click the "Row 3" cell while holding Shift', { action: 'click', args: { modifiers: ['shift'] } }],
  ['Click the Canvas at 10, 20', { action: 'click', args: { position: { x: 10, y: 20 } } }],
  ['Click at 100, 200', { action: 'mouse', args: { op: 'clickAt', x: 100, y: 200 } }],
  ['Drag the "Task A" card to the "Done" column', { action: 'drag', to: expect.objectContaining({ description: 'the "Done" column' }) }],
  ['Drag and drop #a onto #b', { action: 'drag', to: expect.objectContaining({ description: '#b' }) }],
  ['Drag #a to #b using HTML5 events', { action: 'drag', args: { mode: 'html5' } }],
  ['Drag #a to #b with the mouse', { action: 'drag', args: { mode: 'mouse' } }],
  ['Drag the Slider handle by 100, 0', { action: 'drag', args: { offset: { x: 100, y: 0 } } }],
  ['Drag the Slider handle 30 pixels left', { action: 'drag', args: { offset: { x: -30, y: 0 } } }],
  ['Drag the Slider handle down by 15', { action: 'drag', args: { offset: { x: 0, y: 15 } } }],
  ['Move the mouse to 100, 200', { action: 'mouse', args: { op: 'move', x: 100, y: 200 } }],
  ['Press the mouse button on the Canvas', { action: 'mouse', args: { op: 'down' } }],
  ['Press the right mouse button', { action: 'mouse', args: { op: 'down', button: 'right' } }],
  ['Release the mouse button over the Trash icon', { action: 'mouse', args: { op: 'up' } }],
  ['Scroll the mouse wheel down by 300', { action: 'mouse', args: { op: 'wheel', dx: 0, dy: 300 } }],
  ['Scroll down', { action: 'scroll', args: { op: 'page', direction: 'down' } }],
  ['Scroll down by 500', { action: 'scroll', args: { op: 'page', direction: 'down', amount: 500 } }],
  ['Scroll up 200 pixels', { action: 'scroll', args: { op: 'page', direction: 'up', amount: 200 } }],
  ['Scroll to the bottom of the page', { action: 'scroll', args: { op: 'page', direction: 'bottom' } }],
  ['Scroll to the top', { action: 'scroll', args: { op: 'page', direction: 'top' } }],
  ['Scroll the Results list down by 300', { action: 'scroll', args: { op: 'element', direction: 'down', amount: 300 } }],
  ['Scroll the Results list to the bottom', { action: 'scroll', args: { op: 'element', direction: 'bottom' } }],
  ['Scroll to the Footer section', { action: 'scroll', args: { op: 'intoView' } }],
  ['Scroll the Footer section into view', { action: 'scroll', args: { op: 'intoView' } }],
  ['Bring the Footer section into view', { action: 'scroll', args: { op: 'intoView' } }],
  ['Scroll down until the "Item 150" text is visible', { action: 'scroll', args: { op: 'untilVisible', direction: 'down' } }],
  ['Keep scrolling until the "Item 150" text appears at most 20 times', { action: 'scroll', args: { op: 'untilVisible', max: 20 } }],
  ['Scroll down in the Feed list until the "Item 9" text is visible', { action: 'scroll', args: { op: 'untilVisible', container: expect.objectContaining({ description: 'the Feed list' }) } }],
  ['Focus the Search field', { action: 'focus', args: { op: 'focus' } }],
  ['Put the focus on the Search field', { action: 'focus', args: { op: 'focus' } }],
  ['Blur the Email field', { action: 'focus', args: { op: 'blur' } }],
  ['Remove focus from the Email field', { action: 'focus', args: { op: 'blur' } }],
  ['Touch the "Menu" button', { action: 'touch', args: { op: 'tap' } }],
  ['Swipe left on the Carousel', { action: 'touch', args: { op: 'swipe', direction: 'left' } }],
  ['Swipe the Carousel up by 120', { action: 'touch', args: { op: 'swipe', direction: 'up', distance: 120 } }],
  ['Swipe right', { action: 'touch', args: { op: 'swipe', direction: 'right' } }],
  // ---------------------------------------------------------------- events
  ['Trigger the "change" event on the Quantity field', { action: 'dispatch', value: 'change' }],
  ['Fire a "custom-ping" event on #qty with detail \'{"n":1}\'', { action: 'dispatch', value: 'custom-ping', args: { init: { detail: { n: 1 } } } }],
  ['Dispatch the "input" event on the Search field with \'{"bubbles": false}\'', { action: 'dispatch', args: { init: { bubbles: false } } }],
  ['Trigger the "resize" event on the window', { action: 'dispatch', value: 'resize', args: { on: 'window' } }],
  ['Listen for the "cart-updated" event on the window', { action: 'wait', args: { for: 'listen', event: 'cart-updated', on: 'window' } }],
  ['Wait for the "cart-updated" event and capture it as cart', { action: 'wait', args: { for: 'event', event: 'cart-updated' }, captureAs: 'cart' }],
  ['Wait for the "loaded" event on the Map region', { action: 'wait', args: { for: 'event', event: 'loaded' } }],
  ['Wait for the response to /api/orders and capture it as order', { action: 'wait', args: { for: 'response', url: '/api/orders' }, captureAs: 'order' }],
  ['Wait for the POST response from /api/orders with status 201', { action: 'wait', args: { for: 'response', method: 'POST', status: 201 } }],
  ['Wait for a request to /api/track', { action: 'wait', args: { for: 'request', url: '/api/track' } }],
  ['Capture the console errors as errors', { action: 'query', args: { what: 'console', level: 'error' } }],
  ['Capture the console messages as logs', { action: 'query', args: { what: 'console', level: 'any' } }],
  ['Capture the requests to /api as calls', { action: 'query', args: { what: 'requests', name: '/api' } }],
  // ---------------------------------------------------------------- DOM queries
  ['Capture the "href" attribute of the "Docs" link as docsUrl', { action: 'query', args: { what: 'attribute', name: 'href' }, captureAs: 'docsUrl' }],
  ['Get the attribute "aria-expanded" of the Menu button as expanded', { action: 'query', args: { what: 'attribute', name: 'aria-expanded' } }],
  ['Capture the "checked" property of the Terms checkbox as terms', { action: 'query', args: { what: 'property', name: 'checked' } }],
  ['Capture the "color" css of #badge as color', { action: 'query', args: { what: 'css', name: 'color' } }],
  ['Read the computed style "display" of #panel as display', { action: 'query', args: { what: 'css', name: 'display' } }],
  ['Capture the bounding box of the Logo image as logoBox', { action: 'query', args: { what: 'box' } }],
  ['Capture the HTML of the Summary panel as html', { action: 'query', args: { what: 'html' } }],
  ['Capture the outer HTML of the Summary panel as html', { action: 'query', args: { what: 'html', outer: true } }],
  ['Count the "Order" rows as orderCount', { action: 'query', args: { what: 'count' } }],
  ['Capture the number of css=li as items', { action: 'query', args: { what: 'count' } }],
  ['Capture the texts of the "Name" cells as names', { action: 'query', args: { what: 'texts' } }],
  ['Collect all texts of css=li as items', { action: 'query', args: { what: 'texts' } }],
  ['Capture the rows of the Orders table as orders', { action: 'query', args: { what: 'table' } }],
  ['Read the Orders table as orders', { action: 'query', args: { what: 'table' } }],
  ['Capture the current URL as pageUrl', { action: 'query', args: { what: 'url' } }],
  ['Capture the page title as title', { action: 'query', args: { what: 'title' } }],
  ['Capture whether the Newsletter checkbox is checked as subscribed', { action: 'query', args: { what: 'state', name: 'checked' } }],
  ['Capture the text of #toast matching "ORD-\\d+" as orderNumber', { action: 'query', args: { what: 'text', pattern: 'ORD-\\d+' } }],
  // ---------------------------------------------------------------- page scripts
  ['Run JavaScript: return document.title', { action: 'script', value: 'return document.title' }],
  ['Run JavaScript and store the result as t: return document.querySelector("h1").textContent', { action: 'script', captureAs: 't', value: 'return document.querySelector("h1").textContent' }],
  ['Execute JS on the "Products" table: return element.rows.length', { action: 'script', value: 'return element.rows.length' }],
  ['Run script "scripts/seed-cart.js" with items=3 and store the result as cart', { action: 'script', args: { file: 'scripts/seed-cart.js', params: { items: '3' } }, captureAs: 'cart' }],
  // ---------------------------------------------------------------- network
  ['Mock GET /api/orders with status 200 and body "[]"', { action: 'network', args: { op: 'mock', method: 'GET', url: '/api/orders', status: 200, body: '[]' } }],
  ['Stub /api/orders to return status 503', { action: 'network', args: { op: 'mock', url: '/api/orders', status: 503 } }],
  ['Mock the response to /api/orders with body from file "fixtures/orders.json"', { action: 'network', args: { op: 'mock', bodyFile: 'fixtures/orders.json' } }],
  ['Mock POST /api/orders with status 201 and header "location" = "/orders/9" and only 1 times', { action: 'network', args: { op: 'mock', status: 201, headers: { location: '/orders/9' }, times: 1 } }],
  ['Delay /api/orders by 2 seconds', { action: 'network', args: { op: 'delay', url: '/api/orders', ms: 2000 } }],
  ['Slow down requests to /api/* by 500 ms', { action: 'network', args: { op: 'delay', url: '/api/*', ms: 500 } }],
  ['Block images', { action: 'network', args: { op: 'block', preset: 'images' } }],
  ['Block analytics', { action: 'network', args: { op: 'block', preset: 'analytics' } }],
  ['Block requests to /tracking', { action: 'network', args: { op: 'block', url: '/tracking' } }],
  ['Abort POST requests to /api/orders', { action: 'network', args: { op: 'block', method: 'POST', url: '/api/orders' } }],
  ['Make /api/orders fail', { action: 'network', args: { op: 'block', url: '/api/orders' } }],
  ['Set request header "x-test" to "1" for /api/*', { action: 'network', args: { op: 'headers', headers: { 'x-test': '1' }, url: '/api/*' } }],
  ['Stop mocking /api/orders', { action: 'network', args: { op: 'unroute', url: '/api/orders' } }],
  ['Remove all mocks', { action: 'network', args: { op: 'unroute' } }],
  ['Go offline', { action: 'network', args: { op: 'offline' } }],
  ['Go back online', { action: 'network', args: { op: 'online' } }],
  ['Throttle the network to slow 3G', { action: 'network', args: { op: 'throttle', profile: 'slow3g' } }],
  ['Emulate a fast 3G network', { action: 'network', args: { op: 'throttle', profile: 'fast3g' } }],
  ['Stop throttling', { action: 'network', args: { op: 'throttle', profile: 'none' } }],
  ['Save the network traffic as HAR "orders-flow"', { action: 'network', args: { op: 'har', name: 'orders-flow' } }],
  ['Record HAR "checkout" for /api/*', { action: 'network', args: { op: 'har', name: 'checkout', url: '/api/*' } }],
  ['Replay HAR "fixtures/orders.har"', { action: 'network', args: { op: 'replayHar', file: 'fixtures/orders.har' } }],
  // ---------------------------------------------------------------- browser state
  ['Set cookie "theme" to "dark"', { action: 'browser', args: { op: 'setCookie', name: 'theme', value: 'dark' } }],
  ['Add a cookie "ab" with value "B" for example.com', { action: 'browser', args: { op: 'setCookie', name: 'ab', value: 'B', domain: 'example.com' } }],
  ['Delete cookie "theme"', { action: 'browser', args: { op: 'deleteCookie', name: 'theme' } }],
  ['Remove the "theme" cookie', { action: 'browser', args: { op: 'deleteCookie', name: 'theme' } }],
  ['Clear all cookies', { action: 'browser', args: { op: 'clearCookies' } }],
  ['Capture cookie "session" as sessionId', { action: 'browser', args: { op: 'getCookie', name: 'session' }, captureAs: 'sessionId' }],
  ['Capture all cookies as cookies', { action: 'browser', args: { op: 'cookies' } }],
  ['Set local storage "cart" to "[1,2]"', { action: 'browser', args: { op: 'setStorage', area: 'local', key: 'cart', value: '[1,2]' } }],
  ['Set session storage item "step" to "2"', { action: 'browser', args: { op: 'setStorage', area: 'session', key: 'step', value: '2' } }],
  ['Remove "cart" from local storage', { action: 'browser', args: { op: 'removeStorage', area: 'local', key: 'cart' } }],
  ['Clear session storage', { action: 'browser', args: { op: 'clearStorage', area: 'session' } }],
  ['Capture local storage "cart" as cart', { action: 'browser', args: { op: 'getStorage', area: 'local', key: 'cart' } }],
  ['Clear the browser state', { action: 'browser', args: { op: 'clearState' } }],
  ['Grant permission "geolocation"', { action: 'browser', args: { op: 'grant', permissions: ['geolocation'] } }],
  ['Grant permissions "notifications", "camera"', { action: 'browser', args: { op: 'grant', permissions: ['notifications', 'camera'] } }],
  ['Allow notifications', { action: 'browser', args: { op: 'grant', permissions: ['notifications'] } }],
  ['Revoke all permissions', { action: 'browser', args: { op: 'clearPermissions' } }],
  ['Set the geolocation to 52.52, 13.405', { action: 'browser', args: { op: 'geolocation', latitude: 52.52, longitude: 13.405 } }],
  ['Pretend to be at latitude 48.85 and longitude 2.35', { action: 'browser', args: { op: 'geolocation', latitude: 48.85, longitude: 2.35 } }],
  ['Set the timezone to "Asia/Tokyo"', { action: 'browser', args: { op: 'timezone', value: 'Asia/Tokyo' } }],
  ['Use timezone Europe/Berlin', { action: 'browser', args: { op: 'timezone', value: 'Europe/Berlin' } }],
  ['Set the locale to de-DE', { action: 'browser', args: { op: 'locale', value: 'de-DE' } }],
  ['Use dark mode', { action: 'browser', args: { op: 'colorScheme', value: 'dark' } }],
  ['Set the color scheme to light', { action: 'browser', args: { op: 'colorScheme', value: 'light' } }],
  ['Prefer reduced motion', { action: 'browser', args: { op: 'reducedMotion', value: 'reduce' } }],
  ['Emulate print media', { action: 'browser', args: { op: 'media', value: 'print' } }],
  ['Emulate device "iPhone 13"', { action: 'browser', args: { op: 'device', value: 'iPhone 13' } }],
  ['Emulate an iPhone 13', { action: 'browser', args: { op: 'device', value: 'iPhone 13' } }],
  ['Resize the viewport to 375x812', { action: 'browser', args: { op: 'viewport', width: 375, height: 812 } }],
  ['Set the window size to 1280 x 720', { action: 'browser', args: { op: 'viewport', width: 1280, height: 720 } }],
  ['Copy "SAVE10" to the clipboard', { action: 'browser', args: { op: 'clipboardWrite', value: 'SAVE10' } }],
  ['Capture the clipboard as copied', { action: 'browser', args: { op: 'clipboardRead' }, captureAs: 'copied' }],
  ['Use basic auth with username "admin" and password "${adminPassword}"', { action: 'browser', args: { op: 'basicAuth', username: 'admin', password: '${adminPassword}' } }],
  ['Use HTTP credentials "admin" / "s3cret"', { action: 'browser', args: { op: 'basicAuth', username: 'admin', password: 's3cret' } }],
  ['Send header "x-tenant" = "acme" with every request', { action: 'browser', args: { op: 'headers', headers: { 'x-tenant': 'acme' } } }],
  ['Set the user agent to "EZTestBot/1.0"', { action: 'browser', args: { op: 'userAgent', value: 'EZTestBot/1.0' } }],
  // ---------------------------------------------------------------- files
  ['Upload "a.pdf" and "b.pdf" to the Attachments field', { action: 'upload', args: { files: ['a.pdf', 'b.pdf'] } }],
  ['Attach "a.pdf", "b.pdf", "c.pdf" to the Attachments field', { action: 'upload', args: { files: ['a.pdf', 'b.pdf', 'c.pdf'] } }],
  ['Drop file "a.pdf" onto the Drop zone', { action: 'upload', args: { files: ['a.pdf'], mode: 'drop' } }],
  ['Drag files "a.pdf", "b.pdf" to the Drop zone', { action: 'upload', args: { files: ['a.pdf', 'b.pdf'], mode: 'drop' } }],
  // ---------------------------------------------------------------- API, GraphQL, SOAP, WebSocket
  ['Call API "POST /api/notes" with form title=Hello, body=World and store as note', { action: 'api', api: { method: 'POST', url: '/api/notes', form: { title: 'Hello', body: 'World' } }, captureAs: 'note' }],
  ['Call API "GET /api/orders" with query page=2, size=10 and store as page', { action: 'api', api: { query: { page: '2', size: '10' } } }],
  ['Call API "GET /api/orders" as manager with header "x-trace" = "abc" and store as orders', { action: 'api', api: { asRole: 'manager', headers: { 'x-trace': 'abc' } } }],
  ['Call API "POST /api/files" with multipart file=@fixtures/a.pdf, name=doc and store as upload', { action: 'api', api: { multipart: { file: '@fixtures/a.pdf', name: 'doc' } } }],
  ['Call API "PUT /api/orders/1" with body from file "fixtures/order.json" with timeout 5s and store as put', { action: 'api', api: { bodyFile: 'fixtures/order.json', timeoutMs: 5000 } }],
  ['Call API "GET /api/broken" with errors allowed and store as r', { action: 'api', args: { allowErrors: true } }],
  ['Send GraphQL query "{ orders { id } }" to /graphql and store as gq', { action: 'api', api: { method: 'POST', url: '/graphql', graphql: { query: '{ orders { id } }' } }, captureAs: 'gq' }],
  ['Run GraphQL mutation "mutation { add }" on /graphql with variables \'{"a":1}\' and store as m', { action: 'api', api: { graphql: { query: 'mutation { add }', variables: { a: 1 } } } }],
  ['Call SOAP action "GetOrder" on /soap with body "<GetOrder/>" and store as order', { action: 'api', api: { soap: { action: 'GetOrder', body: '<GetOrder/>' } } }],
  ['Call SOAP action "GetOrder" on /soap with body "<GetOrder/>" using SOAP 1.2 and store as order', { action: 'api', api: { soap: { version: '1.2' } } }],
  ['Capture "$.items[0].id" from orders as firstId', { action: 'set', captureAs: 'firstId', args: { extract: { from: 'orders', kind: 'jsonPath', path: '$.items[0].id' } } }],
  ['Capture the header "x-request-id" of orders as requestId', { action: 'set', args: { extract: { kind: 'header', name: 'x-request-id' } } }],
  ['Capture the status of orders as code', { action: 'set', args: { extract: { kind: 'status', from: 'orders' } } }],
  ['Connect to websocket "/ws" as feed', { action: 'ws', args: { op: 'connect', url: '/ws', socket: 'feed' } }],
  ['Open a websocket to "wss://x.test/ws" as feed', { action: 'ws', args: { op: 'connect', url: 'wss://x.test/ws' } }],
  ['Send "ping" on websocket feed', { action: 'ws', value: 'ping', args: { op: 'send', socket: 'feed' } }],
  ['Send websocket message "ping" on feed', { action: 'ws', value: 'ping', args: { op: 'send', socket: 'feed' } }],
  ['Wait for a websocket message containing "pong" on feed and store it as reply', { action: 'ws', args: { op: 'expect', contains: 'pong', socket: 'feed' }, captureAs: 'reply' }],
  ['Wait for a message on websocket feed containing "pong"', { action: 'ws', args: { op: 'expect', contains: 'pong', socket: 'feed' } }],
  ['Close websocket feed', { action: 'ws', args: { op: 'close', socket: 'feed' } }],
  // ---------------------------------------------------------------- databases
  ['Get the value of query "SELECT total FROM orders WHERE id = ${id}" on shop as total', { action: 'db', db: { connection: 'shop', capture: 'cell' }, captureAs: 'total' }],
  ['Get the first row of query "SELECT * FROM orders" on shop as order', { action: 'db', db: { capture: 'row' } }],
  ['Count the rows of query "SELECT * FROM orders" on shop as n', { action: 'db', db: { capture: 'count' } }],
  ['Wait until query "SELECT * FROM jobs WHERE done = 1" on shop returns 1 row within 10 seconds', { action: 'db', poll: { attempts: 10, intervalMs: 1000 } }],
  ['Wait until query "SELECT * FROM jobs" on shop returns rows', { action: 'db', postconditions: [{ type: 'expr', expr: 'len(rows) >= 1' }] }],
  ['Call procedure "close_order" on shop with params \'[42]\' as result', { action: 'db', db: { procedure: 'close_order', params: [42] }, captureAs: 'result' }],
  ['Execute stored procedure "sp_reset" on shop', { action: 'db', db: { procedure: 'sp_reset' } }],
  ['Compare ${dbRows} with ${uiRows} by id', { action: 'compareData', args: { expected: 'dbRows', actual: 'uiRows', key: 'id' } }],
  ['Compare rows dbRows to apiRows by id, name ignoring case and store the result as diff', { action: 'compareData', args: { key: ['id', 'name'], ignoreCase: true }, captureAs: 'diff' }],
  // ---------------------------------------------------------------- email and SMS
  ['Get the latest email to "bob@shop.test" with subject "Welcome" as mail', { action: 'email', args: { to: 'bob@shop.test', subject: 'Welcome' }, captureAs: 'mail' }],
  ['Wait for an email to "bob@shop.test" within 30 seconds as mail', { action: 'email', args: { to: 'bob@shop.test', timeoutMs: 30000 } }],
  ['Get the latest SMS to "+15550100" as sms', { action: 'sms', args: { to: '+15550100' }, captureAs: 'sms' }],
  ['Wait for a text message to "+15550100" containing "code" as sms', { action: 'sms', args: { contains: 'code' } }],
  ['Extract the link from mail matching "verify" as link', { action: 'set', args: { extract: { from: 'mail', kind: 'link', pattern: 'verify' } } }],
  ['Capture the verification link from email mail as link', { action: 'set', args: { extract: { from: 'mail', kind: 'link' } } }],
  ['Extract the 6-digit code from ${sms} as otp', { action: 'set', args: { extract: { from: 'sms', kind: 'code', pattern: '\\b(\\d{6})\\b' } } }],
  ['Extract "INV-\\d+" from ${mail.text} as invoice', { action: 'set', args: { extract: { from: 'mail.text', kind: 'regex', pattern: 'INV-\\d+' } } }],
  // ---------------------------------------------------------------- waits
  ['Wait for the page to load', { action: 'wait', args: { for: 'load', state: 'load' } }],
  ['Wait for the network to be idle', { action: 'wait', args: { for: 'load', state: 'networkidle' } }],
  ['Wait until the network is idle', { action: 'wait', args: { for: 'load', state: 'networkidle' } }],
  ['Wait for the DOM content to load', { action: 'wait', args: { for: 'load', state: 'domcontentloaded' } }],
  ['Wait for the URL to match "/orders/\\d+/"', { action: 'wait', args: { for: 'url', url: '/orders/\\d+/' } }],
  ['Wait for the Save button to be enabled', { action: 'wait', args: { for: 'state', state: 'enabled' } }],
  ['Wait until the Spinner is detached', { action: 'wait', args: { for: 'state', state: 'detached' } }],
  ['Wait for #banner to be removed', { action: 'wait', args: { for: 'state', state: 'detached' } }],
  ['Wait for the Chart to be stable', { action: 'wait', args: { for: 'state', state: 'stable' } }],
  ['Wait for the text of the Status label to change', { action: 'wait', args: { for: 'textChange' } }],
  ['Wait until the Status label changes from "Pending" and store it as status', { action: 'wait', args: { for: 'textChange', from: 'Pending' }, captureAs: 'status' }],
  ['Wait until the Status field has value "Shipped" within 30 seconds checking every 1 second', { action: 'wait', args: { for: 'condition', timeoutMs: 30000, intervalMs: 1000 } }],
  ['Poll until ${count} > 3 every 500 ms', { action: 'wait', args: { for: 'condition', expr: '${count} > 3', intervalMs: 500 } }],
  // ---------------------------------------------------------------- variables
  ['Set variable total to ${price} * ${qty}', { action: 'set', value: '${price} * ${qty}', captureAs: 'total' }],
  ['Set var greeting = upper(name)', { action: 'set', value: 'upper(name)', captureAs: 'greeting' }],
  ['Set ${due} to addDays(today(), 3)', { action: 'set', value: 'addDays(today(), 3)', captureAs: 'due' }],
  ['Let label = "ORD-" + id', { action: 'set', value: '"ORD-" + id', captureAs: 'label' }],
  ['Let label be format(today(), "DD/MM/YYYY")', { action: 'set', captureAs: 'label' }],
  ['Calculate net as round(gross / 1.19, 2)', { action: 'set', value: 'round(gross / 1.19, 2)' }],
  ['Increment count', { action: 'set', value: 'count + 1', captureAs: 'count' }],
  ['Decrease stock by 2', { action: 'set', value: 'stock - 2', captureAs: 'stock' }],
  // ---------------------------------------------------------------- flow control and reuse (single-line forms)
  ['If the "Accept cookies" button is visible then click the "Accept cookies" button', { action: 'if', flow: { condition: expect.objectContaining({ type: 'visible' }) }, steps: [expect.objectContaining({ action: 'click' })] }],
  ['If ${count} > 3: press Tab', { action: 'if', flow: { expr: '${count} > 3' } }],
  ['Unless the Newsletter checkbox is checked then check the Newsletter checkbox', { action: 'if', flow: { negate: true } }],
  ['Repeat 3 times: press Tab', { action: 'repeat', flow: { times: 3 } }],
  ['Repeat ${n} times as i: press Tab', { action: 'repeat', flow: { times: '${n}', as: 'i' } }],
  ['For each item in ${items}: type "${item}" into the Search field', { action: 'forEach', flow: { items: '${items}', as: 'item' } }],
  ['For each order in orders.body: set variable last to order.id', { action: 'forEach', flow: { items: 'orders.body', as: 'order' } }],
  ['For each row in data "users.csv": type "${row.name}" into the Name field', { action: 'forEach', flow: { data: 'users.csv', as: 'row' } }],
  ['For each user in data "users.xlsx" sheet "Team": press Tab', { action: 'forEach', flow: { data: 'users.xlsx', sheet: 'Team', as: 'user' } }],
  ['While the "Load more" button is visible: click the "Load more" button', { action: 'while', flow: { condition: expect.objectContaining({ type: 'visible' }) } }],
  ['While ${n} < 10 at most 20 times: increment n', { action: 'while', flow: { expr: '${n} < 10', maxIterations: 20 } }],
  ['Repeat until the "Done" text is visible: click the "Next" button', { action: 'while', flow: { negate: true } }],
  ['Retry up to 3 times: click the "Refresh" button', { action: 'retry', flow: { attempts: 3 } }],
  ['Retry the following up to 5 times every 2 seconds: click the "Refresh" button', { action: 'retry', flow: { attempts: 5, delayMs: 2000 } }],
  ['Try: click the "Dismiss" button', { action: 'try' }],
  ['Try to click the "Dismiss" button', { action: 'try' }],
  ['Group "Checkout": click the "Pay" button', { action: 'group', value: 'Checkout' }],
  ['Run journey "login-and-open-orders" with role=manager', { action: 'runJourney', value: 'login-and-open-orders', args: { role: 'manager' } }],
  ['Run journey "journeys/lib/login.ez"', { action: 'runJourney', value: 'journeys/lib/login.ez' }],
  ['Run the "Fill name" journey with who="Ada Lovelace" and store the result as filled', { action: 'runJourney', value: 'Fill name', args: { who: 'Ada Lovelace' }, captureAs: 'filled' }],
  ['Include journey "accept-cookies"', { action: 'runJourney', value: 'accept-cookies' }],
  // ---------------------------------------------------------------- soft assertions
  ['Soft expect the page contains "Welcome"', { action: 'assert', soft: true }],
  ['Softly verify the Total field has value "10"', { action: 'assert', soft: true }],
  ['Expect softly that the title contains "Shop"', { action: 'assert', soft: true }],
  ['Click the Save button [soft retry=3 every=200ms]', { action: 'click', soft: true, poll: { attempts: 3, intervalMs: 200 } }],
];

/** [phrase, expected condition subset]. */
export const CONDITION_CASES: Array<[string, Partial<Condition> & Record<string, unknown>]> = [
  ['there are 2 tabs open', { type: 'tabCount', op: 'eq', value: 2 }],
  ['2 windows are open', { type: 'tabCount', value: 2 }],
  ['there is 1 window open', { type: 'tabCount', value: 1 }],
  ['there are more than 1 tabs open', { type: 'tabCount', op: 'gt', value: 1 }],
  ['the number of open tabs is at least 2', { type: 'tabCount', op: 'gte', value: 2 }],
  ['a dialog saying "Saved"', { type: 'dialogSeen', contains: 'Saved' }],
  ['an alert saying "Saved"', { type: 'dialogSeen', contains: 'Saved', kind: 'alert' }],
  ['a confirm dialog with text "Delete?" appeared', { type: 'dialogSeen', contains: 'Delete?', kind: 'confirm' }],
  ['a prompt dialog appeared', { type: 'dialogSeen', kind: 'prompt' }],
  ['no console errors', { type: 'console', level: 'error', max: 0 }],
  ['there are no console errors', { type: 'console', level: 'error', max: 0 }],
  ['there are no JavaScript errors', { type: 'console', level: 'pageerror', max: 0 }],
  ['the console has no warnings', { type: 'console', level: 'warning', max: 0 }],
  ['there are no console errors containing "CSP"', { type: 'console', contains: 'CSP', max: 0 }],
  ['there are at most 2 console warnings', { type: 'console', level: 'warning', max: 2 }],
  ['there are at least 1 console errors', { type: 'console', level: 'error', min: 1 }],
  ['the console contains "loaded"', { type: 'console', level: 'any', contains: 'loaded' }],
  ['the console has errors', { type: 'console', level: 'error' }],
  ['the console has warnings containing "deprecated"', { type: 'console', level: 'warning', contains: 'deprecated' }],
  ['a request was made to "/api/orders"', { type: 'request', url: '/api/orders' }],
  ['a POST request was sent to /api/orders with body containing "qty"', { type: 'request', method: 'POST', bodyContains: 'qty' }],
  ['a request was made to "/api/orders" with header "x-trace" = "abc"', { type: 'request', header: 'x-trace', headerValue: 'abc' }],
  ['a request was made to "/api/orders" with status 201', { type: 'request', status: 201 }],
  ['no request was made to "/analytics"', { type: 'request', negate: true }],
  ['the request to /api/orders contains "Gadget"', { type: 'request', bodyContains: 'Gadget' }],
  ['the POST request to /api/orders had header "x-trace" = "abc"', { type: 'request', method: 'POST', header: 'x-trace' }],
  ['a websocket message containing "pong" was received', { type: 'wsMessage', contains: 'pong' }],
  ['websocket feed received "pong"', { type: 'wsMessage', contains: 'pong', socket: 'feed' }],
  ['the response orders matches the JSON schema "schemas/orders.json"', { type: 'jsonSchema', captureKey: 'orders', schemaFile: 'schemas/orders.json' }],
  ['orders is valid against schema "s.json"', { type: 'jsonSchema', captureKey: 'orders' }],
  ['response orders "$.length" equals "3"', { type: 'jsonPath', path: '$.length', op: 'equals', value: '3' }],
  ['the orders response "$[0].status" contains "Ship"', { type: 'jsonPath', op: 'contains' }],
  ['response orders "$[0].total" is greater than 10', { type: 'jsonPath', op: 'gt', value: '10' }],
  ['response orders has "$[0].id"', { type: 'jsonPath', op: 'exists' }],
  ['response orders does not have "$.error"', { type: 'jsonPath', op: 'absent' }],
  ['the orders response took less than 500 ms', { type: 'responseTime', captureKey: 'orders', maxMs: 500 }],
  ['orders responded within 2 seconds', { type: 'responseTime', maxMs: 2000 }],
  ['the response time of orders is under 300 ms', { type: 'responseTime', maxMs: 300 }],
  ['the download invoice is named "INV-1.pdf"', { type: 'download', captureKey: 'invoice', name: 'INV-1.pdf' }],
  ['the download invoice name matches "INV-\\d+\\.pdf"', { type: 'download', nameMatches: 'INV-\\d+\\.pdf' }],
  ['the download invoice is a "pdf" file', { type: 'download', contentType: 'pdf' }],
  ['the download invoice has type "application/pdf"', { type: 'download', contentType: 'application/pdf' }],
  ['the download invoice is larger than 1 KB', { type: 'download', minBytes: 1025 }],
  ['the download invoice is at most 2 MB', { type: 'download', maxBytes: 2097152 }],
  ['cookie "theme" exists', { type: 'cookie', name: 'theme', op: 'exists' }],
  ['the cookie "theme" is "dark"', { type: 'cookie', op: 'equals', value: 'dark' }],
  ['cookie "session" does not exist', { type: 'cookie', op: 'absent' }],
  ['there is no cookie "tracking"', { type: 'cookie', name: 'tracking', op: 'absent' }],
  ['local storage "cart" is "[]"', { type: 'storage', area: 'local', key: 'cart', op: 'equals', value: '[]' }],
  ['session storage has "step"', { type: 'storage', area: 'session', op: 'exists' }],
  ['local storage "token" does not exist', { type: 'storage', op: 'absent' }],
  ['the "Docs" link has attribute "href"', { type: 'attribute', name: 'href', op: 'exists' }],
  ['the "Docs" link has attribute "target" = "_blank"', { type: 'attribute', op: 'equals', value: '_blank' }],
  ['the Name field does not have attribute "disabled"', { type: 'attribute', op: 'absent' }],
  ['the "href" attribute of the "Docs" link is "/docs"', { type: 'attribute', op: 'equals', value: '/docs' }],
  ['the "class" attribute of #x contains "on"', { type: 'attribute', op: 'contains' }],
  ['the "data-id" attribute of #x matches "^\\d+$"', { type: 'attribute', op: 'matches' }],
  ['the CSS "color" of #badge is "rgb(200, 0, 0)"', { type: 'css', property: 'color', value: 'rgb(200, 0, 0)' }],
  ['the "display" style of #panel is "none"', { type: 'css', property: 'display' }],
  ['#badge has CSS "font-weight" = "700"', { type: 'css', property: 'font-weight', value: '700' }],
  ['the Save button is enabled', { type: 'state', state: 'enabled' }],
  ['the Save button is disabled', { type: 'state', state: 'disabled' }],
  ['the Save button should be disabled', { type: 'state', state: 'disabled' }],
  ['the Name field is editable', { type: 'state', state: 'editable' }],
  ['the Reference field is read-only', { type: 'state', state: 'readonly' }],
  ['the Search field is focused', { type: 'state', state: 'focused' }],
  ['the Terms checkbox is checked', { type: 'state', state: 'checked' }],
  ['the Terms checkbox is not checked', { type: 'state', state: 'unchecked' }],
  ['the Footer section is in the viewport', { type: 'state', state: 'inViewport' }],
  ['the Footer section is out of view', { type: 'state', state: 'notInViewport' }],
  ['the Notes field is empty', { type: 'state', state: 'empty' }],
  ['the Chart is stable', { type: 'state', state: 'stable' }],
  ['the Spinner is detached', { type: 'state', state: 'detached' }],
  ['#badge has class "active"', { type: 'hasClass', value: 'active' }],
  ['#badge does not have class "inactive"', { type: 'hasClass', negate: true }],
  ['there are more than 3 rows in the Orders table', { type: 'countCompare', op: 'gt', value: 3, target: expect.objectContaining({ description: 'rows in the Orders table' }) }],
  ['the Orders table has at least 3 rows', { type: 'countCompare', op: 'gte', value: 3 }],
  ['there are fewer than 10 css=li', { type: 'countCompare', op: 'lt', value: 10 }],
  ['there are at most 5 "Error" messages', { type: 'countCompare', op: 'lte', value: 5 }],
  ['there are between 2 and 5 rows in the Orders table', { type: 'countCompare', op: 'between', value: 2, max: 5 }],
  ['the Results list has more than 3 items', { type: 'countCompare', op: 'gt' }],
  ['the number of css=li is greater than 2', { type: 'countCompare', op: 'gt', value: 2 }],
  ['there are exactly 4 css=td', { type: 'countCompare', op: 'eq', value: 4 }],
  ['css=td.price are sorted ascending', { type: 'sorted', order: 'asc' }],
  ['css=td.name are sorted descending alphabetically', { type: 'sorted', order: 'desc', numeric: false }],
  ['the "Price" column of the Products table is sorted ascending', { type: 'sorted', column: 'Price', order: 'asc' }],
  ['the "Price" column in the Products table is sorted in descending order numerically', { type: 'sorted', column: 'Price', order: 'desc', numeric: true }],
  ['the text of the Order number matches "^ORD-\\d+$"', { type: 'textMatches', pattern: '^ORD-\\d+$' }],
  ['the value of the Phone field matches "\\d{3}-\\d{4}"', { type: 'textMatches', field: 'value' }],
  ['the Order number matches /ORD-\\d+/', { type: 'textMatches', pattern: '/ORD-\\d+/' }],
  ['the query rows returns more than 2 rows', { type: 'expr', expr: 'len(rows) > 2' }],
  ['the expression "len(items) >= 1" is true', { type: 'expr', expr: 'len(items) >= 1' }],
  ['${total} > 100', { type: 'expr', expr: '${total} > 100' }],
  ['len(orders.body) == 3 and orders.status == 200', { type: 'expr' }],
];

function ez(body: string): string {
  return `Journey: Advanced phrasing\n${body}\n`;
}

/** A journey for one line: block openers without an inline step get a body and End. */
function journeyFor(line: string): string {
  const s = parseIntent(line);
  if (Array.isArray(s.steps) && s.steps.length === 0) return ez(`${line}\n  Press Tab\nEnd`);
  return ez(line);
}

function strip(j: Journey): unknown {
  return JSON.parse(JSON.stringify(j, (k, v: unknown) => (k === 'intent' ? undefined : v)));
}

describe('advanced action phrasings', () => {
  it.each(ACTION_CASES)('%s', (line, want) => {
    expect(parseIntent(line)).toMatchObject(want);
  });

  it('round-trips every phrasing through .ez (own wording and canonical wording) and YAML/JSON', () => {
    for (const [line] of ACTION_CASES) {
      const j = parseEzScript(journeyFor(line));
      // 1. own wording
      expect(parseEzScript(journeyToEzScript(j)), line).toEqual(j);
      // 2. canonical wording: forget the author's words and render from the model
      const blank = Journey.parse(JSON.parse(JSON.stringify(j, (k, v: unknown) => (k === 'intent' ? 'zz' : v))));
      const text = journeyToEzScript(blank);
      expect(strip(parseEzScript(text)), `${line}\n---\n${text}`).toEqual(strip(j));
      // 3. YAML and JSON
      expect(normalizeJourneyInput(YAML.parse(YAML.stringify(j))), line).toEqual(j);
      expect(normalizeJourneyInput(JSON.parse(JSON.stringify(j))), line).toEqual(j);
    }
  });
});

describe('advanced expectation phrasings', () => {
  it.each(CONDITION_CASES)('%s', (phrase, want) => {
    expect(parseCondition(phrase)).toMatchObject(want);
  });

  it('renders every expectation back to a phrase that parses to the same condition', () => {
    for (const [phrase] of CONDITION_CASES) {
      const c = parseCondition(phrase);
      expect(parseCondition(conditionToText(c)), phrase).toEqual(c);
      const j = parseEzScript(ez(`Open /\n  Expect ${phrase}\nAssert that ${phrase}`));
      expect(parseEzScript(journeyToEzScript(j)), phrase).toEqual(j);
    }
  });

  it('keeps existing expectations unchanged', () => {
    expect(parseCondition('the "Saved" message is visible')).toMatchObject({ type: 'visible' });
    expect(parseCondition('the spinner is hidden')).toMatchObject({ type: 'hidden' });
    expect(parseCondition('the URL matches "orders/\\d+"')).toMatchObject({ type: 'urlMatches' });
    expect(parseCondition('there are 2 rows in the Orders table')).toMatchObject({ type: 'count', equals: 2 });
    expect(parseCondition('${total} equals "10"')).toMatchObject({ type: 'ledgerEquals' });
  });
});

describe('.ez blocks', () => {
  const NESTED = `Journey: Blocks
Open /lab
If the "Accept cookies" button is visible then
  Click the "Accept cookies" button
    Expect the "Accept cookies" button is hidden
Otherwise if \${count} > 2 then
  Press Tab
Otherwise
  Press Escape
End
For each row in data "users.csv"
  Repeat 2 times
    Type "\${row.name}" into the Name field
  End
End
  Expect the page contains "Done"
Try
  Click the "Dismiss" button
On failure
  Retry up to 2 times
    Click the "Close" button
  End
End
In the "payment" frame
  Type "4242" into the Card number field
End
Group "Checkout"
  Run journey "pay" with amount=10
End
`;

  it('parses nested blocks with else-if, on-failure and post-conditions on blocks', () => {
    const j = parseEzScript(NESTED);
    expect(j.steps.map((s) => s.action)).toEqual(['navigate', 'if', 'forEach', 'try', 'frame', 'group']);
    const iff = j.steps[1];
    expect(iff.steps?.[0].postconditions[0]).toMatchObject({ type: 'hidden' });
    expect(iff.else?.[0]).toMatchObject({ action: 'if', flow: { expr: '${count} > 2' }, steps: [expect.objectContaining({ value: 'Tab' })] });
    expect(iff.else?.[0].else?.[0]).toMatchObject({ action: 'press', value: 'Escape' });
    expect(j.steps[2].steps?.[0].action).toBe('repeat');
    expect(j.steps[2].postconditions[0]).toMatchObject({ type: 'pageContainsText' });
    expect(j.steps[3].catch?.[0]).toMatchObject({ action: 'retry', flow: { attempts: 2 } });
    expect(j.steps[4]).toMatchObject({ action: 'frame', args: { path: ['payment'] } });
    // Ids are unique across the whole tree.
    const ids: string[] = [];
    const walk = (l?: Step[]) => l?.forEach((s) => { ids.push(s.id); walk(s.steps); walk(s.else); walk(s.catch); });
    walk(j.steps);
    expect(new Set(ids).size).toBe(ids.length);
    // Round trip keeps the structure.
    expect(parseEzScript(journeyToEzScript(j))).toEqual(j);
  });

  it('rejects unclosed blocks, stray End and empty blocks with line numbers', () => {
    expect(() => parseEzScript(ez('Repeat 3 times\n  Press Tab'))).toThrow(/line 2: "Repeat 3 times" has no matching "End"/);
    expect(() => parseEzScript(ez('Press Tab\nEnd'))).toThrow(/line 3: "End" has no open block/);
    expect(() => parseEzScript(ez('Repeat 3 times\nEnd'))).toThrow(/has no steps before its End/);
    expect(() => parseEzScript(ez('If ${a} > then\n  Press Tab\nEnd'))).toThrow(/not an expression/);
  });

  it('parses Examples tables and new headers (params, returns, emulation)', () => {
    const j = parseEzScript(`Journey: Search <term>
Params: role
Returns: result
Device: iPhone 13
Viewport: 390x844
Locale: de-DE
Timezone: Europe/Berlin
Color scheme: dark
Reduced motion: reduce
Geolocation: 52.52, 13.40
Permissions: geolocation, notifications
User agent: EZBot/1.0
Touch: on
Offline: no
HTTP credentials: admin / \${pw}
Headers: x-tenant=acme
Type "<term>" into the Search field

Examples:
  | term | expected |
  | laptop | "1 result" |
  | desk, oak | none |
`);
    expect(j).toMatchObject({
      params: ['role'], returns: ['result'],
      emulation: {
        device: 'iPhone 13', viewport: { width: 390, height: 844 }, locale: 'de-DE', timezoneId: 'Europe/Berlin', colorScheme: 'dark', reducedMotion: 'reduce',
        geolocation: { latitude: 52.52, longitude: 13.4 }, permissions: ['geolocation', 'notifications'], userAgent: 'EZBot/1.0', hasTouch: true, offline: false,
        httpCredentials: { username: 'admin', password: '${pw}' }, extraHTTPHeaders: { 'x-tenant': 'acme' },
      },
      examples: [{ term: 'laptop', expected: '1 result' }, { term: 'desk, oak', expected: 'none' }],
    });
    expect(parseEzScript(journeyToEzScript(j))).toEqual(j);
    expect(() => parseEzScript(ez('Press Tab\nExamples:\n  | a |'))).toThrow(/header row and at least one data row/);
  });
});

describe('YAML/JSON blocks', () => {
  it('accepts canonical nested steps and readable block sugar', () => {
    const yaml = `
name: Sugar
steps:
  - Open /lab
  - if: the "Accept cookies" button is visible
    then: [Click the "Accept cookies" button]
    else: [Press Escape]
  - repeat: 2
    steps: [Press Tab]
  - forEach: \${orders.body}
    as: order
    steps: ['Type "\${order.id}" into the Search field']
  - forEach: { data: users.csv, as: user }
    steps: [Press Tab]
  - while: \${n} < 3
    max: 10
    steps: [Increment n]
  - retry: 3
    steps: [Click the "Refresh" button]
  - try: [Click the "Dismiss" button]
    onFailure: [Press Escape]
  - frame: [outer, inner]
    steps: [Click the "OK" button]
  - group: Checkout
    steps: [Press Tab]
  - runJourney: login
    with: { role: manager }
    as: session
  - action: repeat
    flow: { times: 2 }
    steps: [Press Tab]
`;
    const j = normalizeJourneyInput(YAML.parse(yaml));
    expect(j.steps.map((s) => s.action)).toEqual(['navigate', 'if', 'repeat', 'forEach', 'forEach', 'while', 'retry', 'try', 'frame', 'group', 'runJourney', 'repeat']);
    expect(j.steps[1]).toMatchObject({ steps: [expect.objectContaining({ action: 'click' })], else: [expect.objectContaining({ value: 'Escape' })] });
    expect(j.steps[3]).toMatchObject({ flow: { items: '${orders.body}', as: 'order' } });
    expect(j.steps[4]).toMatchObject({ flow: { data: 'users.csv', as: 'user' } });
    expect(j.steps[5]).toMatchObject({ flow: { expr: '${n} < 3', maxIterations: 10 } });
    expect(j.steps[7]).toMatchObject({ catch: [expect.objectContaining({ value: 'Escape' })] });
    expect(j.steps[8]).toMatchObject({ args: { path: ['outer', 'inner'] } });
    expect(j.steps[10]).toMatchObject({ value: 'login', args: { role: 'manager' }, captureAs: 'session' });
    // The canonical JSON form is plain Steps with nested lists, and it converts to .ez and back.
    expect(normalizeJourneyInput(JSON.parse(JSON.stringify(j)))).toEqual(j);
    // (steps written as objects without an intent get their canonical wording)
    expect(strip(parseEzScript(journeyToEzScript(j)))).toEqual(strip(j));
  });
});

describe('helpful errors', () => {
  it('suggests the closest advanced phrasings', () => {
    try {
      parseIntent('Swich to the new tab', { lineNumber: 4 });
      throw new Error('expected an error');
    } catch (e) {
      expect(e).toBeInstanceOf(IntentParseError);
      expect((e as IntentParseError).suggestions).toContain('Switch to the new tab');
    }
    expect(() => parseIntent('Mock /api/x with banana 3')).toThrow(/Unknown mock option "banana 3"/);
    expect(() => parseIntent('Set variable x to 1 +')).toThrow(/not a valid expression/);
  });

  it('keeps every rule example parseable and documents the phrasing counts', () => {
    for (const r of INTENT_RULES) expect(() => parseIntent(r.example), r.name).not.toThrow();
    const doc = readFileSync(new URL('../../docs/ez-language.md', import.meta.url), 'utf8');
    expect(doc).toContain(`## Actions (${INTENT_RULES.length} phrasings)`);
    expect(doc).toContain(`## Expectations (${CONDITION_RULES.length} phrasings)`);
  });
});
