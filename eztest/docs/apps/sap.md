# SAP Fiori pack (and SAP transport impact)

The SAP pack drives Fiori and UI5 apps on the Fiori launchpad in plain English. It cross-checks data through OData V2 and V4. From a transport request, it works out which Fiori journeys and SAP GUI journeys a change breaks. It also checks app and service access per role.

> **Tested against a mock, not a real system.** Every test of this pack runs against `examples/sap-mock`. That mock is an emulation we built from SAP's public documentation of UI5 and Fiori DOM conventions, OData V2 and V4, and the ADT transport API. It is not SAP, and the pack has not been run against a real S/4HANA system. Before you rely on the pack, run it against a sandbox client.

SAP GUI for Windows is a separate rung, documented in [desktop-and-legacy.md](../desktop-and-legacy.md) and driven through EZTest's own SAP GUI Scripting bridge with `Run transaction "VA01"` and `Set SAP field "VBAK-AUART" to "OR"`. Transport impact covers journeys from both rungs.

Source: `src/apps/sap/`. Tests: `test/apps/sap.test.ts` and `test/apps/cli-apps.test.ts`.

## What it covers

| Capability | How |
|---|---|
| OData-aware field resolution | The journey's label is looked up in the app's `$metadata` (`sap:label` for V2, `Common.Label` for V4) to find the property. The pack then finds the control bound to that property through the page's own UI5 runtime, using `sap.ui.getCore().byId(id).getBindingPath('value')`. This runs read-only in the page. Without a UI5 runtime, the pack falls back to the label's `for` association. |
| Smart Controls | The pack handles Smart Fields and Fiori elements fields in edit and display mode: Input, value help icon (`-vhi`) and value help dialog (search, exact row, OK), ComboBox for fixed-value lists, and DatePicker (ISO dates are typed in the UI5 medium style). It also handles the Smart Filter Bar (`Set Fiori filter ...`) and the responsive table (rows, row navigation). |
| Messages | Message toast (success), message popover (backend `errordetails`, one entry per field), field value state. |
| OData cross-check | V2 (`d.results`, `/Date()/`) and V4 (`value`). The pack builds `$filter` from validated property names and quoted literals (`'it''s'`), and fetches a CSRF token for writes (`x-csrf-token: Fetch`). Entity sets can be named by name or label, and a released API (`A_*`) wins over UI services when labels collide. |
| Transport impact | ADT `/sap/bc/adt/cts/transportrequests/{nr}`, or an E071 export. Objects are mapped to transactions, apps and fields, as described below. |
| Metadata snapshots | `$metadata` of every configured service, including labels, types, required flags, create and update restrictions, and fixed value-list values. You can diff two snapshots of the same system, or of a QAS system against DEV. |
| Permission matrix | Fiori app tiles on the launchpad (UI) and OData service and entity-set access as each user (a 403 for a missing S_SERVICE authorisation). |

This pack is aimed at the SAP side of Tricentis Tosca (Fiori and LiveCompare), Worksoft Certify and Impact, Panaya and Leapwork: codeless Fiori automation plus transport-based change impact.

## Configuration

```yaml
sap:
  url: https://s4qas.example.com:44300      # the system journeys run against (QAS)
  client: '100'
  auth: { type: basic, username: COMM_EZTEST, password: secret://vault/sap-comm }   # or oauth2 (BTP / OAuth 2.0 client credentials)
  users:
    clerk: { username: FIORI_CLERK, password: secret://vault/sap-clerk }
  services:
    - { name: SD_SALESORDER_MANAGE_SRV, version: 2, path: /sap/opu/odata/sap/SD_SALESORDER_MANAGE_SRV }
    - { name: API_SALES_ORDER_SRV, version: 2, path: /sap/opu/odata/sap/API_SALES_ORDER_SRV }
    - { name: api_product, version: 4, path: /sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0001 }
  apps:                                     # tile title, intent, main entity set, related transactions and the BSP repository
    - { title: Manage Sales Orders, intent: SalesOrder-manage, service: SD_SALESORDER_MANAGE_SRV, entitySet: C_SalesOrder, tcodes: [VA02, VA03], ui5App: ZSD_SO_MANAGE }
  source:                                   # where transports are released (DEV): compared with url for impact
    url: https://s4dev.example.com:44300
    auth: { type: basic, username: COMM_EZTEST, password: secret://vault/sap-comm-dev }
  objectMap:                                # extends the built-in map (see below)
    'PROG ZSD_PRICING': [VA01, C_SalesOrder.TotalNetAmount]
```

## Phrasings (15 phrasings)

Every phrasing names Fiori, or uses `Verify in SAP OData ...`. The SAP GUI rung keeps `Set SAP field`, `Press SAP button`, `Run transaction` and `the SAP status bar`, so the two rungs never compete.

| Purpose | Phrasings |
|---|---|
| Session and navigation | `Log in to SAP Fiori as clerk` · `Open the Fiori app "Manage Sales Orders"` · `Open the Fiori list item "4711"` |
| Fields | `Set Fiori field "Sales Order Type" to "Standard Order"` · `Set Fiori field "Sold-To Party" to "17100002" using the value help` · `Set Fiori filter "Sold-To Party" to "17100002"` |
| Actions | `Press the Fiori button "Go"` · `Press the Fiori button "Edit"` · `Save the Fiori object` · `Save the Fiori object and expect the error "Enter a purchase order number"` |
| Checks | `Expect Fiori field "Sales Order Type" to be "Standard Order (OR)"` · `Expect Fiori field "Customer Reference" to be mandatory` (also `read-only`, `editable` or `hidden`) · `Expect the Fiori toast to contain "created"` · `Expect the Fiori message popover to contain "does not exist"` · `Expect the Fiori table to have 2 rows` · `Expect the Fiori table to contain "4711"` · `Expect the Fiori value help for "Sold-To Party" to contain "Domestic Customer US 11"` · `Expect the Fiori tile "Manage Products" to be hidden` |
| OData | `Verify in SAP OData that A_SalesOrder "${sap.key}" has SalesOrderType = "OR" and "Customer Reference" = "PO-1"` · `Verify in SAP that sales order "4712" has PurchaseOrderByCustomer = "PO-2"` |

Value-list values match by key, by text, or by `Text (Key)`, and always exactly: `"Domestic Customer US"` never picks `Domestic Customer US 1`.

## Transport impact (G33)

```bash
eztest apps impact sap --transport DEVK900123 --transport DEVK900130 journeys
eztest apps impact sap --transport-file e071-export.json journeys       # offline: no second system needed
eztest apps snapshot sap -o qas.json --release QAS
eztest apps snapshot sap -o dev.json --system source --release DEV
eztest apps impact sap --before qas.json --after dev.json journeys
```

Each transport object is mapped to what journeys use:

| Object | Mapped to |
|---|---|
| `R3TR TRAN VA01` | SAP GUI journeys running VA01, and Fiori apps listing it under `tcodes` |
| `R3TR PROG`, `LIMU REPS`, `FUGR` and `CLAS` | The transactions and apps in the object map (the built-in map covers SAPMV45A and its user exits, and SAPLMEGUI) |
| `R3TR TABL`, `TABU` and `VIEW` | GUI fields `TABLE-*`, plus the table's transactions and entity sets. `TABU` keys deleted in the transport (`TVAK` order type `CR`) become removed values |
| `R3TR DTEL` and `DOMA` | The fields typed with them. The pack reads their labels from both systems through ADT `/sap/bc/adt/ddic/dataelements/{name}`, so a relabel is precise |
| `R3TR IWSV`, `SRVB`, `SRVD`, `DDLS` and `IWOM` | The service's entity sets. The pack compares their `$metadata` in both systems and attributes each difference to the object that causes it |
| `R3TR WAPA` | The Fiori app deployed from that BSP repository (`ui5App`) |
| `R3TR ACGR` | A security review of the mapped apps |

The pack never guesses the mapping for an object it cannot place. It reports the object as unmapped under `untested`, so you can add it to `sap.objectMap`. A label change only breaks steps that use the **old** label; a journey that names the technical field `VBKD-BSTKD` is marked for review instead.

## Permission matrix

```yaml
- { app: Manage Sales Orders, expect: { clerk: visible, productManager: hidden } }
- { service: api_product, entitySet: Product, expect: { clerk: none, productManager: read } }
```

```bash
eztest apps permissions sap --checks perms.yaml --ui
```

## Limits

- The launchpad conventions handled are tiles on the home page and hash intents. The pack does not handle spaces and pages, the My Home layout or in-place navigation into SAP GUI for HTML. Use the SAP GUI rung for GUI transactions.
- Object pages are handled in display and edit (draft-less) mode. The pack handles one main entity set per app, and it does not edit sub-object tables (items).
- Field resolution uses the page's UI5 runtime only through `byId(id).getMetadata().getName()` and `getBindingPath('value')`. It has been checked only against the mock's emulation of these calls.
- The built-in object map is a starting point for standard SD and MM objects. Real where-used analysis (RFC or ADT usage references) is not implemented, so add your custom objects to `sap.objectMap`.
