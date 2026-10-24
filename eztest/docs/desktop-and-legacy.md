# Desktop and legacy apps

EZTest drives Windows desktop apps, Java Swing apps, SAP GUI, mainframe green screens, Electron apps, and Citrix/VDI or canvas-only screens. It uses the same plain-English journeys as for the web. These apps form a ladder of drivers, from the most semantic to the least:

| Rung | Driver | Finds elements by | How it connects |
|---|---|---|---|
| 1 | **Electron** | role and accessible name, label, text, test id, CSS, XPath (the web locators) | EZTest starts the app with `--remote-debugging-port=0` and talks to its renderer over the Chrome DevTools Protocol |
| 2 | **Windows UI Automation** (WinForms, WPF, Win32, UWP) | AutomationId, Name and ControlType, LabeledBy, the window | EZTest's own Windows agent (`agents/windows`, .NET 8, Microsoft UI Automation) |
| 3 | **Java Swing/AWT** | component name, text, accessible name, JLabel `labelFor`, the component type | EZTest's own `-javaagent` (`agents/java`), which runs inside the app's JVM |
| 4 | **SAP GUI for Windows** | scripting id, technical name (`VBAK-AUART`), the field's label, tooltip | SAP GUI Scripting through EZTest's own PowerShell/COM bridge (`agents/sap`) |
| 5 | **Mainframe TN3270 & IBM i TN5250** | the label printed next to the field, row and column, the cursor | EZTest's own TN3270 and TN5250 clients in TypeScript (telnet, the 3270/5250 data streams, fields, function keys) |
| 6 | **Image and OCR** (Citrix/VDI, canvas, remote screens) | OCR text, image templates, coordinates | VNC (EZTest's own RFB client), the browser page, a desktop agent's screen, an Electron window, or a still image |

EZTest uses no third-party automation tool: no Playwright, Puppeteer, Selenium, Appium, WinAppDriver, Marathon, AutoIt or Sikuli. The agents use only platform APIs: Windows UI Automation and SendInput, Swing/AWT, and SAP GUI Scripting. OCR uses tesseract.js, an optional peer library that runs locally in WebAssembly. Template matching is EZTest's own code.

## One language for every surface

The ordinary phrasings work on whichever surface is active. These include `Click the "Save" button`, `Type "ACME" into the "Customer" field`, `Select "EUR" from the "Currency" dropdown`, `Check the "Paid" checkbox`, `Press Enter` and `Press Ctrl+S`. Reading and checking work the same way: `Read the "BALANCE" field as balance`, `Expect the screen to contain "Saved"` and `Expect the "NAME" field contains "ADA"`.

A surface becomes active when a step opens it, for example `Connect to mainframe "cics"`, `Launch the Java app "ledger"`, `Connect to SAP "ERP"`, `Connect to Citrix "desk1"` or `App: electron main.js`. `Switch to the browser` goes back to the web page, and `Switch to the mainframe` (or `the desktop app`, `SAP`, `the screen`) returns to an open session. API, database, variable and wait steps keep working in between, so one journey can check a mainframe record against a web UI and a database.

Every step records **which driver and which rung acted**, for example `rung: field, via label "USERID" at row 5 column 10` or `rung: image, score 0.98 at 125%`. It also records the element's screen box. You can see both in the report, in the trace, and in Studio's **Desktop & legacy** run tab.

## Healing and verification

Each driver records an element fingerprint when a step passes. For a desktop app, this is the control type, name, AutomationId, label, class, window and position. For a terminal, it is the label, row, column, length and field type. For SAP, it is the technical name, label and type. When the description no longer matches (a button is renamed, or a field's label changes or moves), the step **heals**. It first tries the cached verified heal (T0), then the closest fingerprint (T1, which must clearly beat the runner-up).

A heal counts only when the step's expectations still hold, or when the action implies a check (for example, a healed field must now hold the typed value). The step is then reported as `passed-healed`. Ambiguity (two matching elements) is never healed. It fails and names the matches.

## Evidence

| Surface | Image | Structured snapshot |
|---|---|---|
| Electron | window PNG | DOM (`.html`) |
| Windows / Java | window PNG | UI tree as XML (`<Button Name="Save" AutomationId="btnSave" …>`) |
| SAP GUI | `HardCopy` PNG | screen elements and status bar (JSON) |
| TN3270 | an SVG "green screen" (input fields underlined, the acted-on field outlined) | screen text and fields (JSON); non-display (password) fields are always blank |
| Image / OCR | screenshot with match boxes and click marks drawn in | matches, clicks and OCR text (JSON) |

Snapshots are stored in the hash-chained Evidence Vault. With the default `screenshots: on-failure` policy, EZTest stores them on failure, after a heal, and after every step that changes the screen (an AID key, a menu, a click). With `every-step`, it stores them after every step. All text goes through the secret masker.

## Mainframe (TN3270)

```yaml
# eztest.config.yaml
mainframe:
  hosts:
    cics:
      host: mf.example.com
      port: 992
      tls: true                   # certificate verification is always on
      caFile: certs/mainframe-ca.pem
      model: 2                    # 24x80; 3 = 32x80, 4 = 43x80, 5 = 27x132
      timeoutMs: 15000            # wait for the host after an AID key
      logon: { userField: USERID, passwordField: PASSWORD, key: Enter }
      users:
        clerk: { user: CLERK01, password: secret://vault/mf-clerk }
```

```text
Journey: Account inquiry
Connect to mainframe "cics"
Log on to the mainframe as "clerk"
  Expect the screen to contain "MAIN MENU"
Type "1" in field at row 20 column 14
Press Enter
Type "10000001" into the "ACCOUNT NUMBER" field
Press Enter
  Expect the screen to contain "ACCOUNT FOUND"
Expect the field at row 8 column 22 to be "ACTIVE"
Read the "BALANCE" field as balance
Press PF3
Wait until the screen contains "MAIN MENU" within 30 seconds
Disconnect from the mainframe
```

- **Fields:** use `into the "USERID" field` (the nearest input field to the right of that label, or just below it), `in field at row R column C`, or `at the cursor` (TSO line mode). `Read the "BALANCE" field` also reads protected output to the right of a label.
- **Keys:** `Press Enter`, `PF1`–`PF24`, `PA1`–`PA3`, `Clear` and `SysReq` send an AID and wait for the next screen (keyboard unlock plus a short quiet time). `Tab`, `Backtab`, `Home` and `Erase EOF` act locally.
- **Rules a real terminal enforces:** EZTest refuses to type into a protected field, past the end of a field, or non-digits into a numeric field, and says so clearly.
- **Protocol:** EZTest negotiates TN3270 (BINARY, EOR and TERMINAL-TYPE, `IBM-3278-2-E` by default), answers the host's Read Partition Query, and handles Write, Erase/Write, Erase/Write Alternate, Erase All Unprotected and WSF, plus the SF, SFE, SBA, SA, MF, IC, PT, RA, EUA and GE orders. TN3270E (RFC 2355) is declined, so the host falls back to plain TN3270.
- **Offline testing:** `MainframeSimulator` (from `@eztech/eztest/legacy`) serves screens you define as data. `createDemoBankApp()` is a three-screen example. EZTest's own tests use it, and they also run against a real MVS 3.8j (TK4- on Hercules) when `EZ_TK4=host:port` is set.

## IBM i green screens (TN5250)

EZTest has its own TN5250 client in TypeScript — telnet negotiation (TERMINAL-TYPE `IBM-3179-2` or `IBM-3477-FC`, NEW-ENVIRON `DEVNAME`, BINARY, END-OF-RECORD), the 5250 data stream, the field format table and function keys — alongside the TN3270 one. Set `protocol: tn5250` on the host:

```yaml
mainframe:
  hosts:
    ez400: { host: ibmi.example.com, port: 992, tls: true, protocol: tn5250, deviceName: EZTEST01,
             users: { clerk: { user: CLERK01, password: secret://vault/ibmi-clerk } } }
```

```text
Journey: Customer inquiry on IBM i
Connect to IBM i "ez400"
Sign on to the IBM i as "clerk"
  Expect the screen to contain "IBM i Main Menu"
Type "1" into the "Selection or command" field
Press Enter
Type "100001" into the "Customer number" field
Press Enter
  Expect the screen to contain "Customer found."
Read the "Balance" field as balance
Press F3
Sign off from the IBM i
```

- **Phrasings are shared with TN3270** (Connect, Type into / at row-column, Read, Expect the field, Press, Disconnect). The sign-on screen's fields default to `User` / `Password`.
- **Keys:** `Enter`, `F1`–`F24`, `Page Up`/`Page Down` (Roll Down/Up), `Help`, `Print`, `Clear`, `SysReq` and `Attn` send an attention key; `Field Exit`, `Field+`, `Field-`, `Reset` and `Erase EOF` act locally. A Write Error Code message inhibits the keyboard until `Reset`.
- **Fields** come from the format table's Start Of Field orders (bypass, shift/edit, monocase, mandatory-enter, right-adjust); EZTest refuses to type into a bypass field, past the end, or non-digits into a numeric field. Field finding and healing by label/length/position are the TN3270 code, so a renamed field heals the same way.
- **Offline testing:** `Ibmi5250Simulator` and `createDemoIbmiApp()` (from `@eztech/eztest/legacy`) are a stand-in IBM i (sign-on, main menu, customer inquiry) used by EZTest's own tests; `EZ_IBMI=host:port` runs the suite against a real host.

## Windows desktop apps

Run EZTest's Windows agent on the Windows machine (or VM) that runs the app:

```text
dotnet publish agents/windows -c Release -r win-x64 --self-contained
ez-windows-agent.exe --port 47123 --token <secret>      # loopback only unless --host and --token are given
```

```yaml
desktop:
  windows:
    url: http://10.0.0.5:47123      # the agent
    token: secret://vault/win-agent
    apps:
      invoice: { app: 'C:\Apps\Invoice.exe' }
      calc: { app: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }   # UWP AUMID
      running: { window: 'Invoice Manager' }                          # attach instead of launching
```

```text
Journey: Save an invoice
Launch the desktop app "invoice"
Type "Contoso" into the "Customer" field
Check the "Urgent" checkbox
Choose "File > Save As..." from the menu
Expect the "Save As" window to be open
Choose "C:\data\inv-1.inv" in the file dialog
  Expect the screen to contain "Saved to C:\data\inv-1.inv"
Expect cell row 1 column "Qty" of the "Lines" grid to be "2"
Expand "Customers > Europe" in the "Accounts" tree
Click the "Save" button in the "Invoice - inv-1.inv" window
Press Ctrl+S
Close the desktop app
```

- **Locating:** `#txtAmount` or `testid=txtAmount` is an AutomationId. `the "Save" button` is Name plus ControlType (Button). `the "Customer" field` is an Edit (or ComboBox/Document) with that Name or LabeledBy, or the edit right after a "Customer" label. A step that names no window searches the current window and then the app's other top-level windows (modal dialogs).
- **Actions:** the agent uses UI Automation patterns (Invoke, Value, Toggle, ExpandCollapse, SelectionItem, Grid/Table, Window). Mouse and keyboard go through SendInput. `Switch to the "Save As" window` and `Close the tab` act on windows.
- **Status:** the agent compiles (`dotnet build` on Linux with `EnableWindowsTargeting`), but it has not been run here, because there is no Windows host. The TypeScript client is tested against a simulator of the agent's API.

## Java Swing/AWT apps

```yaml
desktop:
  java:
    # agentJar: tools/ez-java-agent.jar   # optional: otherwise EZTest builds it from agents/java with javac on first use
    apps:
      ledger:
        command: [java, -jar, apps/ledger.jar]   # EZTest adds -javaagent (or JAVA_TOOL_OPTIONS for launcher scripts)
        env: { DISPLAY: ':99' }
      remote: { url: http://10.0.0.7:47200 }    # a JVM already started with the agent
```

```text
Journey: Create an invoice
Launch the Java app "ledger"
Type "ACME Corp" into the "Customer" field
Select "EUR" from the "Currency" dropdown
Click the "Save" button
  Expect the screen to contain "Saved invoice 1 for ACME Corp"
Read cell row 1 column "Amount" of the "invoiceTable" grid as amount
Choose "File > New Invoice" from the menu
Press Enter in the "Amount" field
Close the desktop app
```

The agent (`-javaagent:ez-java-agent.jar=port=0,token=…,portFile=…`) serves the same API as the Windows agent. It reports Swing components with UI Automation control type names: JButton is Button, JTextField is Edit, JComboBox is ComboBox, JMenuItem is MenuItem, JTable is Table, and so on. So the same locators, healing and evidence apply.

The agent runs reads on the event dispatch thread. Actions are queued, so a modal dialog that a click opens does not block the agent. Key events go straight to the component's listeners and key bindings, so they work without a window manager (for example under Xvfb). Screenshots are painted from the component tree, which needs no screen grabber.

## SAP GUI for Windows

Run EZTest's SAP bridge next to SAP GUI. It needs SAP GUI Scripting enabled on the server (`sapgui/user_scripting`) and in the client options:

```text
powershell -ExecutionPolicy Bypass -File agents/sap/ez-sap-bridge.ps1 -Port 8765 -Token <secret>
```

```yaml
desktop:
  sap:
    bridge: http://127.0.0.1:8765
    token: secret://vault/sap-bridge
    systems:
      ERP: { connection: ERP Development, client: '100', user: TESTER, password: secret://vault/sap-tester, language: EN }
```

```text
Journey: Create a standard order
Connect to SAP "ERP"
Log on to SAP
Run transaction "VA01"
Set SAP field "Order Type" to "OR"
Type "1000" into the "Sales Organization" field
Press Enter
Set SAP field "Sold-To Party" to "1000"
Set cell row 1 column "Material" of SAP table "All Items" to "M-01"
Press SAP button "Save"
Expect the SAP status bar to be a success message
Capture the number from the SAP status bar as orderNumber
```

- **Fields:** a field can be named by its scripting id (`wnd[0]/usr/ctxtVBAK-AUART`), its technical name (`VBAK-AUART`), its label (`LeftLabel`) or its tooltip. Buttons are found by text or tooltip (`Save`).
- **Keys:** keys map to SAP virtual keys: Enter (0), F1–F12, Shift+F1–F12 (13–24), Ctrl+F1–F12 (25–36), Ctrl+S (11), Escape (12), PageUp and PageDown.
- **Status bar:** the status bar is a first-class check. You can assert on its text, on the message type (S, E, W, I, A), or capture a number from it.
- **Status:** the bridge is our own script. It is parsed, and its HTTP and token layer is run for real under PowerShell in Docker. Its COM calls have not been run, because there is no SAP system here. The TypeScript side is tested against a simulator of the bridge.

## Electron apps

```text
Journey: Place an order in the desktop app
App: electron "apps/orders/main.js"
Type "Contoso" into the "Customer" field
Click the "Place order" button
  Expect the page to contain "Order placed for Contoso"
Click the "Open report" button
Switch to the new window
  Expect the screen to contain "3 orders today"
```

`App: electron <main.js or app dir> [args]` launches the app before the first step. `App:` is shared with native mobile: only a value starting with `electron` means a desktop app. Any other value (`App: "com.shop.app"`) is the mobile app under test for `Platform: android|ios` (see [mobile.md](mobile.md)). YAML/JSON journeys use `electron: { app, args }` for desktop and `app:` for mobile. `Launch the Electron app "…"` does the same as a step. The binary comes from the project's `electron` package, or from `desktop.electron.executablePath`. EZTest drives the renderer over the DevTools protocol through a small seam (`CdpPageSeam`). A fixed in-page script resolves the usual EZ locators, and input goes through CDP `Input.*`.

## Citrix/VDI, canvas apps and other pixels (image and OCR)

```yaml
citrix:
  sessions:
    desk1: { vnc: 'vdi-gw.example.com:5901', password: secret://vault/vdi-vnc }
  images: test-images            # image templates resolve against this directory
  match: { threshold: 0.9, scales: [1, 1.25, 1.5, 0.8, 2] }
  ocr: { lang: eng, minConfidence: 60 }   # needs: npm i -D tesseract.js @tesseract.js-data/eng
```

```text
Journey: Approve in the Citrix app
Connect to Citrix "desk1"
Wait for the image "citrix/ready.png" on screen within 60 seconds
Click the text "Approvals" on screen
Double-click the image "citrix/first-row.png"
Read the text in region 10,20,300,40 as total
Type "approved by EZTest" on screen
Press Enter
Expect the screen to contain "Approved"
```

- **Screens:** `Connect to Citrix "…"` uses VNC (RFB 3.3/3.7/3.8 with None or VNC Authentication; Raw, CopyRect and DesktopSize encodings). `Use the browser page as the screen` covers canvas-only web apps. `Use the desktop app window as the screen` uses an open Windows, Java or Electron app's pixels. `Use the screen image "x.png"` analyses a still image offline. Image and OCR steps that run with no screen opened use the browser page.
- **Image templates:** templates are matched by zero-mean normalised cross-correlation on grayscale. EZTest tries several scales (DPI 100/125/150/80/200%), with a coarse-to-fine search. A match must reach the threshold. Two equally good matches are reported as ambiguous instead of picking one.
- **OCR:** OCR runs Tesseract on a 2x upscaled image. It makes a second, polarity-normalised pass, so light text on dark bars is read too, and words must reach `minConfidence`. Phrases match across consecutive words on one line, ignoring case and punctuation.
- **Field heuristics:** with no object tree, `Type "x" into the "Customer" field` clicks to the right of the OCR'd label and types. `Read the "Total" field` reads the text to the right of the label.
- **Limits:** text inside framed buttons is often misread by Tesseract. Target buttons by image template, and keep OCR for labels and messages. VNC is the transport. EZTest has no ICA/HDX client, so expose the session through VNC (or run EZTest on the VDI desktop with the Windows agent).

## Agent protocol (ez-agent/1)

The Windows agent, the Java agent and the SAP bridge all speak the same protocol. Each request is `POST /v1/rpc` with the body `{"method": "...", "params": {...}}` and the header `X-EZ-Agent-Token`. Each answer is `{"ok": true, "result": ...}` or `{"ok": false, "error": {"code", "message"}}`. Agents listen on loopback by default and compare tokens in constant time.

| Methods | Windows / Java agent |
|---|---|
| Session | `hello`, `launch {app, args, workingDir}` (Windows), `windows`, `activate`, `closeWindow` |
| Tree | `elements {window}`: a flat list of `{id, parent, controlType, name, automationId, className, framework, labeledBy, value, toggle, expanded, selected, enabled, visible, rect}` |
| Actions | `invoke`, `setValue`, `getValue`, `toggle {state}`, `expand`, `collapse`, `select`, `focus`, `keys {keys: ["CTRL","S"]}`, `typeText`, `mouse {x, y, button, double}`, `cell {id, row, column, value?}`, `treePath {id, path, op}` |
| Evidence | `screenshot {window?}` returns `{png: base64}` |

The SAP bridge's methods are `hello`, `open`, `login`, `transaction`, `dump`, `get`, `set`, `press`, `select`, `vkey`, `status`, `cell`, `screenshot` and `close`.

## Programmatic use

```ts
import { createDesktopIntegration } from '@eztech/eztest/desktop';
import { Tn3270Client, MainframeSimulator, createDemoBankApp } from '@eztech/eztest/legacy';

const { interceptor } = createDesktopIntegration({ mainframe: { hosts: { bank: { host: '127.0.0.1', port: 3270 } } } });
await runJourneys(journeys, { outputDir: 'out', stepInterceptors: [interceptor] });   // createEngine() wires this from config

const c = await Tn3270Client.connect({ host: 'mf', port: 23 });
await c.waitForScreen();
c.fill(c.field('USERID').field, 'CLERK01');
await c.pressAndWait('Enter');
```

Extension points for other surfaces are in the runner. `RunOptions.stepInterceptors` see every step first. `setActiveSurface(session, surface)` lets a surface answer conditions such as "the screen contains" while it is active.

Desktop surfaces use step interceptors rather than a `PlatformDriver` (`src/runner/platform.ts`). A platform driver owns a whole journey on one device, which suits mobile. A desktop journey often mixes surfaces: a mainframe screen, then the web UI, then an API or database check, switching back and forth. Interceptors keep the web runner's step loop, waits, healing, evidence and post-conditions, and claim only the steps of the active desktop surface. The browser starts only when a step needs it.
