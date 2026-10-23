/**
 * Desktop and legacy phrasings (docs/desktop-and-legacy.md): Windows and Java
 * desktop apps, SAP GUI, mainframe terminals (TN3270) and the image/OCR rung
 * for Citrix/VDI and canvas-only screens. Each builds a `custom` step whose
 * handler the desktop interceptor runs; ordinary phrasings (Click, Type,
 * Press, Expect ...) need no rules here, they are routed to the active surface.
 *
 * The rules are spliced in before the assertion rules, so every pattern is
 * anchored on wording a web journey does not use (quoted image files, "row R
 * column C", "PF3", "SAP", "mainframe", "on screen", menu paths with ">").
 */
import type { StepBody, IntentRule } from './rules.js';
import { literal, protectQuotes, restoreQuotes } from './quotes.js';
import { describeTarget } from './target.js';

const Q = String.raw`(⟦\d+⟧)`;
const KEY = String.raw`([A-Za-z_][\w.]*)`;
const ROWCOL = String.raw`row\s+(\d+)\s*(?:,\s*|\s+)col(?:umn)?\s+(\d+)`;
const ASSERT = String.raw`(?:expect|verify|assert|ensure|confirm|check)(?:\s+that)?`;
const ONSCREEN = String.raw`on\s+(?:the\s+)?screen`;
const IMG = /\.(?:png|jpe?g|bmp|gif)$/i;
const DUR = String.raw`(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)`;

const V = (s: string, q: string[]) => literal(s, q);
const custom = (handler: string, args: Record<string, unknown>): StepBody => ({ action: 'custom', handler, args });
const ms = (n: string, u: string) => (/^ms|milli/i.test(u) ? Number(n) : /^m(?:in)?/i.test(u) && !/^ms/i.test(u) ? Number(n) * 60_000 : Number(n) * 1000);

function cat(category: string, rules: IntentRule[]): IntentRule[] {
  return rules.map((r) => ({ ...r, category }));
}

/** IBM i (TN5250) names in connect/sign-on/disconnect phrasings. */
const IBMI = String.raw`ibm\s*i|as\/?400|i\s*series|system\s+i|tn5250|5250\s+host`;

/** Display-station keys with no single-word name, normalised for the terminal surfaces (PageDown also works in a browser). */
const TERMINAL_KEYS: Record<string, string> = {
  fieldexit: 'Field Exit', 'field+': 'Field+', 'field-': 'Field-', fieldplus: 'Field+', fieldminus: 'Field-', reset: 'Reset',
  rollup: 'RollUp', rolldown: 'RollDown', pageup: 'PageUp', pagedown: 'PageDown', help: 'Help', print: 'Print', attn: 'Attn', attention: 'Attn',
  eraseeof: 'Erase EOF', recordbackspace: 'Record Backspace',
};

const MAINFRAME = cat('Mainframe', [
  { name: 'mainframe-connect', keywords: ['connect', 'open'], example: 'Connect to mainframe "cics"',
    re: new RegExp(String.raw`^(?:connect|log\s*in|attach)\s+to\s+(?:the\s+)?(mainframe|terminal|tn3270|green\s+screen|host|${IBMI})(?:\s+(?:host|system))?\s+${Q}$`, 'i'),
    build: (m, q) => custom('terminal.connect', { host: V(m[2], q), ...(new RegExp(`^(?:${IBMI})$`, 'i').test(m[1]) ? { protocol: 'tn5250' } : /^tn3270$/i.test(m[1]) ? { protocol: 'tn3270' } : {}) }) },
  { name: 'mainframe-logon', keywords: ['log', 'sign'], example: 'Log on to the mainframe as "clerk"',
    re: new RegExp(String.raw`^(?:log|sign)\s*(?:on|in)\s+to\s+(?:the\s+)?(?:mainframe|terminal|host|${IBMI})\s+as\s+${Q}$`, 'i'),
    build: (m, q) => custom('terminal.logon', { user: V(m[1], q) }) },
  { name: 'terminal-5250-key', keywords: ['press'], example: 'Press Field Exit',
    re: /^(?:press|hit)\s+(?:the\s+)?(field\s*exit|field\s*\+|field\s*-|field\s+plus|field\s+minus|reset|roll\s*up|roll\s*down|page\s*up|page\s*down|help|print|attn|attention|erase\s*eof|record\s+backspace)(?:\s+key)?$/i,
    build: (m) => ({ action: 'press', value: TERMINAL_KEYS[m[1].toLowerCase().replace(/\s+/g, '')] ?? m[1] }) },
  { name: 'mainframe-type-at', keywords: ['type', 'enter'], example: 'Type "ACCT01" in field at row 5 column 20',
    re: new RegExp(String.raw`^(?:type|enter|key\s+in|put)\s+${Q}\s+(?:(?:in|into)\s+(?:the\s+)?(?:input\s+)?field\s+)?at\s+${ROWCOL}$`, 'i'),
    build: (m, q) => custom('terminal.typeAt', { text: V(m[1], q), row: Number(m[2]), col: Number(m[3]) }) },
  { name: 'mainframe-type-cursor', keywords: ['type', 'enter'], example: 'Type "LOGOFF" at the cursor',
    re: new RegExp(String.raw`^(?:type|enter|key\s+in)\s+${Q}\s+at\s+the\s+cursor$`, 'i'),
    build: (m, q) => custom('terminal.typeAt', { text: V(m[1], q), cursor: true }) },
  { name: 'mainframe-aid-key', keywords: ['press'], example: 'Press PF3',
    re: /^(?:press|hit|send)\s+(?:the\s+)?(PF\s?\d{1,2}|PA\s?[1-3]|clear|sys\s?req|attn)(?:\s+key)?$/i,
    build: (m) => ({ action: 'press', value: m[1].replace(/\s+/g, '').toUpperCase() }) },
  { name: 'mainframe-read-at', keywords: ['read', 'capture', 'get'], example: 'Read the field at row 6 column 22 as name',
    re: new RegExp(String.raw`^(?:read|capture|get|grab)\s+(?:the\s+)?(?:field|text|value)\s+at\s+${ROWCOL}(?:\s+(?:length|for)\s+(\d+)(?:\s+characters)?)?\s+as\s+${KEY}$`, 'i'),
    build: (m) => custom('terminal.readAt', { row: Number(m[1]), col: Number(m[2]), ...(m[3] ? { length: Number(m[3]) } : {}), as: m[4] }) },
  { name: 'mainframe-expect-at', keywords: ['expect', 'verify', 'check'], example: 'Expect the field at row 8 column 22 to be "ACTIVE"',
    re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?(?:field|text|value)\s+at\s+${ROWCOL}\s+(?:to\s+(be|equal|contain|show)|is|equals|contains|shows)\s+${Q}$`, 'i'),
    build: (m, q) => custom('terminal.expectAt', { row: Number(m[1]), col: Number(m[2]), value: V(m[4], q), op: /contain/i.test(m[0]) ? 'contains' : 'equals' }) },
  { name: 'mainframe-disconnect', keywords: ['disconnect', 'log'], example: 'Disconnect from the mainframe',
    re: new RegExp(String.raw`^(?:disconnect|log\s*off|sign\s*off)\s+(?:from\s+)?(?:the\s+)?(?:mainframe|terminal|host|${IBMI})$`, 'i'),
    build: () => custom('terminal.disconnect', {}) },
]);

const SCREEN = cat('Screen', [
  { name: 'screen-wait-text', keywords: ['wait'], example: 'Wait for the screen to contain "READY"',
    re: new RegExp(String.raw`^wait\s+(?:until|for)\s+(?:the\s+)?(?:screen\s+(?:to\s+)?(?:contains?|shows?|display)\s+${Q}|text\s+${Q}\s+(?:to\s+appear\s+)?${ONSCREEN})(?:\s+(?:within|for\s+up\s+to)\s+${DUR})?$`, 'i'),
    build: (m, q) => ({ action: 'wait', args: { for: 'condition', condition: { type: 'pageContainsText', value: V(m[1] ?? m[2], q) }, ...(m[3] ? { timeoutMs: ms(m[3], m[4]) } : {}) } }) },
  { name: 'screen-switch', keywords: ['browser'], example: 'Switch to the browser',
    re: /^(?:switch|go|change|return)\s+(?:back\s+)?to\s+(?:the\s+)?(browser|web\s+page|web|mainframe|terminal|ibm\s*i|as\/?400|desktop\s+app|desktop|windows\s+app|java\s+app|sap|sap\s+gui|screen|citrix)(?:\s+(⟦\d+⟧))?$/i,
    build: (m, q) => custom('surface.use', { to: m[1].toLowerCase().replace(/\s+(?:app|gui|page)$/, '').replace(/^web$/, 'browser').replace(/^ibm\s*i$/, 'ibm i').replace(/^as\/?400$/, 'as400'), ...(m[2] ? { name: V(m[2], q) } : {}) }) },
  { name: 'screen-snapshot', keywords: ['take', 'capture'], example: 'Take a snapshot of the screen',
    re: /^(?:take|capture|save)\s+(?:a\s+)?(?:screen\s*shot|snapshot|picture)\s+of\s+(?:the\s+)?(?:screen|terminal|mainframe\s+screen|desktop\s+app|window|sap\s+screen)$/i,
    build: () => custom('surface.snapshot', {}) },
]);

const VISION = cat('Image and OCR', [
  { name: 'vision-use-browser', keywords: ['use'], example: 'Use the browser page as the screen',
    re: /^use\s+(?:the\s+)?(?:browser\s+page|web\s+page|page|canvas)\s+as\s+the\s+screen$/i,
    build: () => custom('vision.use', { source: 'browser' }) },
  { name: 'vision-use-desktop', keywords: ['use'], example: 'Use the desktop app window as the screen',
    re: /^use\s+(?:the\s+)?(?:desktop\s+app|windows\s+app|java\s+app|app)(?:\s+window)?\s+as\s+the\s+screen$/i,
    build: () => custom('vision.use', { source: 'desktop' }) },
  { name: 'vision-connect', keywords: ['connect'], example: 'Connect to Citrix "desk1"',
    re: new RegExp(String.raw`^(?:connect|attach)\s+to\s+(?:the\s+)?(?:citrix|vdi|vnc|remote\s+desktop)(?:\s+(?:session|desktop))?\s+${Q}$`, 'i'),
    build: (m, q) => custom('vision.use', { source: 'citrix', name: V(m[1], q) }) },
  { name: 'vision-use-image', keywords: ['use'], example: 'Use the screen image "fixtures/screen.png"',
    re: new RegExp(String.raw`^use\s+(?:the\s+)?screen\s*(?:shot|image)\s+${Q}$`, 'i'),
    build: (m, q) => custom('vision.use', { source: 'image', image: V(m[1], q) }) },
  { name: 'vision-click-image', keywords: ['click', 'double-click', 'right-click'], example: 'Click the image "citrix/ok-button.png"',
    re: new RegExp(String.raw`^(click|tap|double[-\s]?click|right[-\s]?click)\s+(?:on\s+)?(?:the\s+)?image\s+${Q}(?:\s+${ONSCREEN})?$`, 'i'),
    build: (m, q) => {
      const image = V(m[2], q);
      if (!IMG.test(image)) return undefined;
      return custom('vision.clickImage', { image, ...(/double/i.test(m[1]) ? { double: true } : {}), ...(/right/i.test(m[1]) ? { button: 'right' } : {}) });
    } },
  { name: 'vision-click-text', keywords: ['click', 'double-click'], example: 'Click the text "Submit" on screen',
    re: new RegExp(String.raw`^(click|tap|double[-\s]?click|right[-\s]?click)\s+(?:on\s+)?(?:the\s+)?(?:text|word|words|label)\s+${Q}\s+${ONSCREEN}$`, 'i'),
    build: (m, q) => custom('vision.clickText', { text: V(m[2], q), ...(/double/i.test(m[1]) ? { double: true } : {}), ...(/right/i.test(m[1]) ? { button: 'right' } : {}) }) },
  { name: 'vision-click-at', keywords: ['click'], example: 'Click at 120,340 on screen',
    re: new RegExp(String.raw`^(click|tap|double[-\s]?click|right[-\s]?click)\s+at\s+(?:x\s*=?\s*)?(\d+)\s*(?:,|\s+y\s*=?)\s*(\d+)\s+${ONSCREEN}$`, 'i'),
    build: (m) => custom('vision.clickAt', { x: Number(m[2]), y: Number(m[3]), ...(/double/i.test(m[1]) ? { double: true } : {}), ...(/right/i.test(m[1]) ? { button: 'right' } : {}) }) },
  { name: 'vision-read-region', keywords: ['read', 'capture'], example: 'Read the text in region 10,20,300,40 as total',
    re: new RegExp(String.raw`^(?:read|capture|ocr|get)\s+(?:the\s+)?text\s+(?:in|of|from)\s+(?:the\s+)?(?:screen\s+)?region\s+(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s+as\s+${KEY}$`, 'i'),
    build: (m) => custom('vision.read', { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]), as: m[5] }) },
  { name: 'vision-read-screen', keywords: ['read'], example: 'Read the screen text as screenText',
    re: new RegExp(String.raw`^(?:read|capture|ocr)\s+(?:all\s+)?(?:the\s+)?(?:text\s+on\s+the\s+screen|screen\s+text|screen)\s+as\s+${KEY}$`, 'i'),
    build: (m) => custom('vision.read', { as: m[1] }) },
  { name: 'vision-expect-image', keywords: ['expect', 'verify'], example: 'Expect the image "citrix/logo.png" on screen',
    re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?(?:screen\s+(?:to\s+)?(not\s+to\s+|does\s+not\s+)?(?:shows?|contains?|display)\s+the\s+image\s+${Q}|image\s+${Q}\s+(?:is\s+|to\s+be\s+)?(not\s+)?(?:visible\s+|shown\s+)?${ONSCREEN})$`, 'i'),
    build: (m, q) => {
      const image = V(m[2] ?? m[3], q);
      if (!IMG.test(image)) return undefined;
      return custom('vision.expectImage', { image, ...(m[1] || m[4] ? { negate: true } : {}) });
    } },
  { name: 'vision-wait-image', keywords: ['wait'], example: 'Wait for the image "citrix/ready.png" on screen',
    re: new RegExp(String.raw`^wait\s+(?:until|for)\s+(?:the\s+)?image\s+${Q}(?:\s+to\s+appear)?(?:\s+${ONSCREEN})?(?:\s+(?:within|for\s+up\s+to)\s+${DUR})?$`, 'i'),
    build: (m, q) => {
      const image = V(m[1], q);
      if (!IMG.test(image)) return undefined;
      return custom('vision.waitImage', { image, ...(m[2] ? { timeoutMs: ms(m[2], m[3]) } : {}) });
    } },
  { name: 'vision-type', keywords: ['type'], example: 'Type "invoice 42" on screen',
    re: new RegExp(String.raw`^(?:type|enter|key\s+in)\s+${Q}\s+${ONSCREEN}$`, 'i'),
    build: (m, q) => custom('vision.type', { text: V(m[1], q) }) },
]);

const WINDOWS = cat('Desktop', [
  { name: 'desktop-launch', keywords: ['launch', 'start', 'open'], example: 'Launch the desktop app "invoice"',
    re: new RegExp(String.raw`^(?:launch|start|open|run)\s+(?:the\s+)?(desktop|windows|win32|wpf|winforms|uwp|java|swing|electron)\s+(?:app|application|program)\s+${Q}(?:\s+with\s+(?:the\s+)?arguments?\s+${Q})?$`, 'i'),
    build: (m, q) => custom('desktop.launch', { driver: /java|swing/i.test(m[1]) ? 'java' : /electron/i.test(m[1]) ? 'electron' : 'windows', app: V(m[2], q), ...(m[3] ? { args: V(m[3], q) } : {}) }) },
  { name: 'desktop-attach', keywords: ['attach'], example: 'Attach to the "Invoice Manager" window',
    re: new RegExp(String.raw`^attach\s+to\s+(?:the\s+)?(?:running\s+)?(?:(desktop|windows|java)\s+)?(?:app\s+|application\s+)?(?:window\s+)?${Q}(?:\s+window)?$`, 'i'),
    build: (m, q) => custom('desktop.attach', { driver: m[1] && /java/i.test(m[1]) ? 'java' : 'windows', window: V(m[2], q) }) },
  { name: 'desktop-menu', keywords: ['choose', 'select', 'open', 'click'], example: 'Choose "File > Save As" from the menu',
    re: new RegExp(String.raw`^(?:choose|select|pick|click|open)\s+(?:the\s+)?(?:menu\s+(?:item\s+)?)?${Q}(?:\s+(?:from|in|on)\s+(?:the\s+)?(?:menu|menu\s+bar|main\s+menu|application\s+menu))?$`, 'i'),
    build: (m, q) => {
      const path = V(m[1], q);
      if (!/\s>\s/.test(path)) return undefined;
      return custom('desktop.menu', { path: path.split(/\s+>\s+/).map((p) => p.trim()) });
    } },
  { name: 'desktop-expect-window', keywords: ['expect', 'verify'], example: 'Expect the "Save As" window to be open',
    re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?(?:desktop\s+)?(?:window\s+)?${Q}\s+(?:window\s+)?(?:not\s+to\s+be\s+|to\s+not\s+be\s+|to\s+be\s+not\s+|is\s+not\s+|to\s+be\s+|is\s+|not\s+)?(?:open|opened|shown|showing|displayed)$`, 'i'),
    build: (m, q) => custom('desktop.expectWindow', { window: V(m[1], q), ...(/\bnot\b/i.test(m[0]) ? { negate: true } : {}) }) },
  { name: 'desktop-close', keywords: ['close', 'quit', 'exit'], example: 'Close the desktop app',
    re: /^(?:close|quit|exit|stop)\s+(?:the\s+)?(?:desktop|windows|java)\s+(?:app|application)$/i,
    build: () => custom('desktop.close', {}) },
  { name: 'desktop-grid-read', keywords: ['read', 'get'], example: 'Read cell row 2 column "Amount" of the "Invoices" grid as amount',
    re: new RegExp(String.raw`^(?:read|get|capture)\s+(?:the\s+)?cell\s+(?:at\s+)?row\s+(\d+)\s*(?:,\s*|\s+)col(?:umn)?\s+(${Q.slice(1, -1)}|\d+)\s+(?:of|in)\s+(?:the\s+)?${Q}\s+(?:grid|table|list)\s+as\s+${KEY}$`, 'i'),
    build: (m, q) => custom('desktop.cell', { row: Number(m[1]), column: V(m[2], q), grid: V(m[3], q), as: m[4] }) },
  { name: 'desktop-grid-expect', keywords: ['expect', 'verify'], example: 'Expect cell row 2 column "Status" of the "Invoices" grid to be "Paid"',
    re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?cell\s+(?:at\s+)?row\s+(\d+)\s*(?:,\s*|\s+)col(?:umn)?\s+(${Q.slice(1, -1)}|\d+)\s+(?:of|in)\s+(?:the\s+)?${Q}\s+(?:grid|table|list)\s+(?:to\s+(be|equal|contain)|is|equals|contains)\s+${Q}$`, 'i'),
    build: (m, q) => custom('desktop.cell', { row: Number(m[1]), column: V(m[2], q), grid: V(m[3], q), expect: V(m[5], q), op: /contain/i.test(m[4] ?? m[0]) ? 'contains' : 'equals' }) },
  { name: 'desktop-grid-set', keywords: ['set'], example: 'Set cell row 1 column "Qty" of the "Lines" grid to "3"',
    re: new RegExp(String.raw`^(?:set|type|enter)\s+(?:the\s+)?cell\s+(?:at\s+)?row\s+(\d+)\s*(?:,\s*|\s+)col(?:umn)?\s+(${Q.slice(1, -1)}|\d+)\s+(?:of|in)\s+(?:the\s+)?${Q}\s+(?:grid|table|list)\s+to\s+${Q}$`, 'i'),
    build: (m, q) => custom('desktop.cell', { row: Number(m[1]), column: V(m[2], q), grid: V(m[3], q), value: V(m[4], q) }) },
  { name: 'desktop-tree', keywords: ['expand', 'select'], example: 'Expand "Customers > Europe" in the "Accounts" tree',
    re: new RegExp(String.raw`^(expand|select|open|collapse)\s+${Q}\s+(?:in|of)\s+(?:the\s+)?${Q}\s+tree(?:\s+view)?$`, 'i'),
    build: (m, q) => custom('desktop.tree', { op: m[1].toLowerCase() === 'open' ? 'expand' : m[1].toLowerCase(), path: V(m[2], q).split(/\s+>\s+/), tree: V(m[3], q) }) },
  { name: 'desktop-file-dialog', keywords: ['choose', 'select'], example: 'Choose "C:\\data\\orders.csv" in the file dialog',
    re: new RegExp(String.raw`^(?:in\s+the\s+file\s+dialog,?\s+)?(?:choose|select|pick|open|enter)\s+(?:the\s+file\s+)?${Q}(?:\s+in\s+the\s+(?:file|open|save(?:\s+as)?)\s+dialog)?$`, 'i'),
    build: (m, q) => (/^in\s+the\s+file\s+dialog|\s+dialog$/i.test(m[0]) ? custom('desktop.fileDialog', { path: V(m[1], q) }) : undefined) },
]);

const SAP = cat('SAP GUI', [
  { name: 'sap-connect', keywords: ['connect', 'open'], example: 'Connect to SAP "ERP"',
    re: new RegExp(String.raw`^(?:connect|attach)\s+to\s+(?:the\s+)?sap(?:\s+gui)?(?:\s+system)?\s+${Q}$`, 'i'),
    build: (m, q) => custom('sap.connect', { system: V(m[1], q) }) },
  { name: 'sap-logon', keywords: ['log', 'sign'], example: 'Log on to SAP "ERP"',
    re: new RegExp(String.raw`^(?:log|sign)\s*(?:on|in)\s+to\s+(?:the\s+)?sap(?:\s+gui)?(?:\s+system)?(?:\s+${Q})?$`, 'i'),
    build: (m, q) => custom('sap.logon', { ...(m[1] ? { system: V(m[1], q) } : {}) }) },
  { name: 'sap-transaction', keywords: ['run', 'start', 'open'], example: 'Run transaction "VA01"',
    re: new RegExp(String.raw`^(?:run|start|open|call|execute|go\s+to)\s+(?:the\s+)?(?:sap\s+)?(?:transaction|t-?code|tcode)\s+(${Q.slice(1, -1)}|[A-Za-z0-9_/]+)$`, 'i'),
    build: (m, q) => custom('sap.transaction', { code: V(m[1], q) }) },
  { name: 'sap-set-field', keywords: ['set'], example: 'Set SAP field "Sold-To Party" to "1000"',
    re: new RegExp(String.raw`^(?:set|fill|enter)\s+(?:the\s+)?sap\s+field\s+${Q}\s+(?:to|with)\s+${Q}$`, 'i'),
    build: (m, q) => custom('sap.set', { field: V(m[1], q), value: V(m[2], q) }) },
  { name: 'sap-press-button', keywords: ['press', 'click'], example: 'Press SAP button "Save"',
    re: new RegExp(String.raw`^(?:press|click|push)\s+(?:the\s+)?sap\s+(?:button|toolbar\s+button)\s+${Q}$`, 'i'),
    build: (m, q) => custom('sap.press', { button: V(m[1], q) }) },
  { name: 'sap-status-expect', keywords: ['expect', 'verify'], example: 'Expect the SAP status bar to contain "has been saved"',
    re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?(?:sap\s+)?status\s*bar\s+(?:message\s+)?(?:to\s+(contain|show|say|be)|contains|shows|says|is)\s+${Q}$`, 'i'),
    build: (m, q) => custom('sap.status', { contains: V(m[2], q) }) },
  { name: 'sap-status-type', keywords: ['expect', 'verify'], example: 'Expect the SAP status bar to be a success message',
    re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?(?:sap\s+)?status\s*bar\s+(?:message\s+)?(?:to\s+be|is)\s+an?\s+(success|error|warning|information|abort)\s+message$`, 'i'),
    build: (m) => custom('sap.status', { type: ({ success: 'S', error: 'E', warning: 'W', information: 'I', abort: 'A' } as Record<string, string>)[m[1].toLowerCase()] }) },
  { name: 'sap-status-read', keywords: ['read', 'capture'], example: 'Capture the number from the SAP status bar as orderNumber',
    re: new RegExp(String.raw`^(?:read|capture|get|grab)\s+(?:the\s+)?(?:(number|message|text)\s+(?:from|in|of)\s+(?:the\s+)?(?:sap\s+)?status\s*bar|(?:sap\s+)?status\s*bar(?:\s+message)?)\s+as\s+${KEY}$`, 'i'),
    build: (m) => custom('sap.status', { as: m[2], ...(m[1]?.toLowerCase() === 'number' ? { pattern: '\\d+' } : {}) }) },
  { name: 'sap-table-cell', keywords: ['set'], example: 'Set cell row 1 column "Material" of SAP table "All Items" to "M-01"',
    re: new RegExp(String.raw`^(?:set|enter|type)\s+(?:the\s+)?cell\s+(?:at\s+)?row\s+(\d+)\s*(?:,\s*|\s+)col(?:umn)?\s+${Q}\s+(?:of|in)\s+(?:the\s+)?sap\s+(?:table|grid)\s+${Q}\s+to\s+${Q}$`, 'i'),
    build: (m, q) => custom('sap.cell', { row: Number(m[1]), column: V(m[2], q), table: V(m[3], q), value: V(m[4], q) }) },
  { name: 'sap-table-read', keywords: ['read'], example: 'Read cell row 1 column "Net Value" of SAP table "All Items" as net',
    re: new RegExp(String.raw`^(?:read|get|capture)\s+(?:the\s+)?cell\s+(?:at\s+)?row\s+(\d+)\s*(?:,\s*|\s+)col(?:umn)?\s+${Q}\s+(?:of|in)\s+(?:the\s+)?sap\s+(?:table|grid)\s+${Q}\s+as\s+${KEY}$`, 'i'),
    build: (m, q) => custom('sap.cell', { row: Number(m[1]), column: V(m[2], q), table: V(m[3], q), as: m[4] }) },
]);

// "Read the "BALANCE" field as balance": a field's text on any surface (web too).
const READ = cat('Desktop', [
  { name: 'read-element-as', keywords: ['read'], example: 'Read the "BALANCE" field as balance',
    re: new RegExp(String.raw`^read\s+((?:the\s+)?${Q.slice(1, -1)}(?:\s+(?:field|value|text|label|output|box))?|#[\w-]+|(?:testid|test-id|data-testid)=\S+)\s+(?:as|into)\s+${KEY}$`, 'i'),
    build: (m, q) => ({ action: 'capture', target: describeTarget(restoreQuotes(m[1].trim(), q)), captureAs: m[2], args: { mode: 'text' } }) },
]);

/** All desktop and legacy rules, in match order (SAP and vision before the generic Desktop rules). */
export const DESKTOP_RULES: IntentRule[] = [...MAINFRAME, ...SCREEN, ...SAP, ...VISION, ...WINDOWS, ...READ];

/**
 * Expect lines that are desktop steps of their own (screen positions, grid cells, images, windows, the SAP
 * status bar), not post-conditions of the step before them.
 */
export function isDesktopExpectation(line: string): boolean {
  const { text } = protectQuotes(line.trim());
  return DESKTOP_RULES.some((r) => /^(?:mainframe-expect-at|desktop-grid-expect|desktop-expect-window|vision-expect-image|sap-status-expect|sap-status-type)$/.test(r.name) && r.re.test(text));
}
