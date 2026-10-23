# Oracle pack (Fusion Cloud and E-Business Suite)

The Oracle pack drives Oracle Fusion Cloud Redwood pages and E-Business Suite OA Framework (web) pages in plain English: fields, lists of values (LOVs) and tables. It cross-checks data through the Fusion REST API, reports which journeys a quarterly update breaks, and checks job roles, REST resources and Navigator pages per user.

> **Tested against a mock, not a real pod.** Every test of this pack runs against `examples/oracle-mock`. That mock is an emulation we built from Oracle's public documentation of Redwood (Oracle JET core-pack components), OA Framework pages and the Fusion REST API. It is not Oracle, and the pack has not been run against a real Fusion pod or EBS instance. Before you rely on the pack, run it against a test pod.

Source: `src/apps/oracle/`. Tests: `test/apps/oracle.test.ts`.

## What it covers

| Capability | How |
|---|---|
| Redwood fields | JET core-pack elements found by `label-hint`: `oj-c-input-text`, `oj-c-input-number`, `oj-c-input-date-text` (ISO dates are typed as MM/DD/YYYY) and `oj-c-select-single` LOVs (type-ahead, then the result is picked exactly). Required and read-only state comes from the `required` and `readonly` attributes and the label's required icon. |
| Redwood tables | `oj-c-table` by its `aria-label`. Cells are addressed by row number and column header, and editable cells are driven like fields. |
| Redwood messages | Inline field messages, message banners and toasts. The number in `Purchase order 1002 submitted.` is captured as `${oracle.number}`. |
| EBS OA Framework | `x8` prompt labels (`label for`) and required markers (`span.x6`), poplists, and the modal **Search and Select** LOV inside its iframe (search, then an exact row, then Select). `OraMessageBox` errors and confirmations, and the Navigator (`responsibility > function`). |
| REST cross-check | Attribute titles are resolved through `/{resource}/describe`. The `q=` finder is built from validated attribute names with doubled quotes, and the request uses `fields=` and `onlyData=true`. |
| Quarterly update impact | `describe` snapshots of the current pod and a pod that already has the update. They cover attribute titles, types, mandatory and updatable flags, and LOV values through `lov.childRef`. The update's feature list (CSV or JSON) adds renamed fields, newly required fields, retired values and page changes. Redwood pages use the same attribute titles as their field labels, so a relabeled attribute also points at the UI steps. |
| Permission matrix | Job roles from `hcmRestApi` `userAccounts` (`expand=userAccountRoles`), REST resource access as each user, and Navigator pages as each user (UI). |

This pack is aimed at the Oracle coverage of ACCELQ, Opkey, Tosca and Functionize: Redwood and EBS automation plus quarterly-update regression scoping.

## Configuration

```yaml
oracle:
  url: https://acme.fa.us2.oraclecloud.com           # Fusion UI and REST
  ebsUrl: https://ebs.example.com                     # optional: EBS OA Framework pages (/OA_HTML)
  auth: { type: basic, username: EZTEST.INTEGRATION, password: secret://vault/ora-int }
  # auth: { type: oauth2, tokenUrl: https://idcs-....identity.oraclecloud.com/oauth2/v1/token, clientId: ..., clientSecret: secret://vault/ora-cs, scope: ... }
  users:
    buyer: { username: CASEY.BROWN, password: secret://vault/ora-buyer }
    requester: { username: PAT.STOCK, password: secret://vault/ora-req }
  resources:
    - { name: purchaseOrders, path: /fscmRestApi/resources/11.13.18.05/purchaseOrders, key: OrderNumber, label: purchase order, pages: [Create Purchase Order, Purchase Orders] }
  testPod: { url: https://acme-test.fa.us2.oraclecloud.com, auth: { type: basic, username: EZTEST.INTEGRATION, password: secret://vault/ora-test } }
```

## Phrasings (12 phrasings)

Every phrasing names Oracle (`Oracle`, `Oracle Fusion` or `Oracle EBS`).

| Purpose | Phrasings |
|---|---|
| Session and navigation | `Log in to Oracle Fusion as buyer` · `Log in to Oracle EBS as requester` · `Open the Oracle page "Create Purchase Order"` · `Open the Oracle EBS function "iProcurement > Non-Catalog Request"` |
| Fields | `Set Oracle field "Supplier" to "Lee Supplies"` (a Redwood LOV) · `Set Oracle field "Category" to "COMPUTER.HARDWARE" using the list of values` (the EBS Search and Select) |
| Tables | `Set Oracle table "Lines" row 1 column "Quantity" to "2"` |
| Actions | `Press the Oracle button "Add Line"` · `Press the Oracle button "Submit"` |
| Checks | `Expect the Oracle message to contain "submitted"` · `Expect the Oracle error to contain "Enter a value."` · `Expect the Oracle confirmation to contain "has been submitted for approval"` · `Expect Oracle field "Buyer" to be "Casey Brown"` · `Expect Oracle field "Requisitioning BU" to be mandatory` · `Expect the Oracle table "Lines" to have 1 row` · `Expect the Oracle table "Purchase Orders" to contain "Lee Supplies"` · `Expect the Oracle page "Create Purchase Order" to be unavailable` |
| REST | `Verify in Oracle Fusion that purchase order "${oracle.number}" has Supplier = "Lee Supplies" and Status = "Pending Approval"` |

## Quarterly update impact

```bash
eztest apps snapshot oracle -o 25C.json --release 25C
eztest apps snapshot oracle -o 25D.json --release 25D --pod test
eztest apps impact oracle --before 25C.json --after 25D.json --features 25D-features.csv --release 25D journeys
```

When `oracle.testPod` is configured, `eztest apps impact oracle` without `--before`/`--after` snapshots both pods itself. The feature list is a CSV or JSON table with the columns `Update`, `Feature`, `Change_Type`, `Page`, `Field`, `New_Value` and `Description`. `Change_Type` takes one of these values: Field Renamed, Field Required, Field Removed, Value Retired, Page Retired, or anything else for a UI change.

## Permission matrix

```yaml
- { role: Buyer, expect: { buyer: assigned, requester: not-assigned } }
- { resource: purchaseOrders, expect: { buyer: read, requester: none } }
- { page: Create Purchase Order, expect: { buyer: available, requester: unavailable } }
```

## Limits

- **EBS Forms** (the Java applet or JNLP desktop forms) are not web pages, and this pack does not drive them. You can use the desktop Java agent rung for them, but we have not tested that against Oracle Forms. EBS has no REST API by default, so cross-check EBS data with the database steps (Oracle connections, [databases.md](../databases.md)).
- Redwood pages are handled through JET core-pack components in light DOM. The pack does not handle classic ADF Faces pages (`af:` components, ADF tables and popups).
- Role analysis reads job role assignments. The pack does not resolve data security, data access sets or duty-role inheritance.
