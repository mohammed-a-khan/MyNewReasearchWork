# ServiceNow pack

The ServiceNow pack drives UI16 forms, lists and the Service Portal in plain English. It cross-checks records through the Table API, reports which journeys an update set or an upgrade breaks, and checks access per role.

> **Tested against a mock, not a real instance.** Every test of this pack runs against `examples/servicenow-mock`. That mock is an emulation we built from ServiceNow's public documentation of its UI16 DOM, Service Portal, Table API, dictionary tables, update sets and upgrade history. It is not ServiceNow, and the pack has not been run against a real instance or a Personal Developer Instance (PDI). Before you rely on the pack, run it against your own PDI.

Source: `src/apps/servicenow/`. Tests: `test/apps/servicenow.test.ts` and `test/apps/cli-apps.test.ts`.

## What it covers

| Capability | How |
|---|---|
| Form fields by label | The label is resolved through `sys_dictionary` and `sys_documentation`, following table inheritance (an incident inherits `short_description` from `task`). The pack then drives the `element.<table>.<field>` container: text, choice lists (matched by label or value), reference fields (`sys_display.*` plus autocomplete, which must match exactly), checkboxes and journal fields. |
| UI actions | Header buttons by label or action name (`Submit`, `Update`, `Resolve`). Mandatory-field and business-rule failures are read from the output messages. |
| Related lists | `tabs2_list` by caption, with the row contents. |
| Service Portal | The catalog item is opened through `sc_cat_item`. Variables are resolved through `item_option_new` and `question_choice` (labels, mandatory flags, select boxes, checkboxes). **Order Now** captures the REQ and RITM numbers. |
| Table API cross-check | Uses `sysparm_display_value=all`, so both the stored value and the display value are compared. Encoded queries are built from validated names, and a value can never add a term: `^` and line breaks are rejected. Dot-walks (`caller_id.email`) and `variables.<name>` on requested items are supported. |
| Impact: update sets | Every `sys_update_xml` record is classified and its payload compared with the live dictionary. The record types covered are dictionary entries, field labels, choices, UI policies and policy actions, UI actions, business rules, client scripts, form layouts, ACLs, catalog items and variables. |
| Impact: upgrades | Records that `sys_upgrade_history_log` reports as skipped (disposition 4, which is configurable) become review items for the journeys that use them. |
| Impact: snapshots | A dictionary snapshot per configured table. Diff two of them, either two instances or before and after a commit. |
| Permission matrix | Table and field read access through the Table API, called as each user: a 403 means no read ACL, and a field missing from the response means no field ACL. Optionally, the pack also checks what the UI16 form shows that user (no form, read-only or editable) and which UI actions it offers. |

This pack is aimed at what AutomatePro (ServiceNow-native), ACCELQ, Functionize, Testsigma and Tosca market for ServiceNow: field-level form automation, catalog ordering, Table API validation and upgrade or update-set impact. The pack runs outside the instance, so it does not need a ServiceNow store app.

## Configuration

```yaml
servicenow:
  instanceUrl: https://acme.service-now.com
  # Integration user for the Table API: basic, or OAuth (/oauth_token.do: password or client_credentials grant)
  auth: { type: basic, username: eztest.integration, password: secret://vault/sn-int }
  # auth: { type: oauth2, tokenUrl: https://acme.service-now.com/oauth_token.do, clientId: ..., clientSecret: secret://vault/sn-cs, grant: client_credentials }
  users:                       # roles for "Log in to ServiceNow as <role>" and the permission matrix
    itil: { username: beth.anglin, password: secret://vault/sn-itil }
    employee: { username: abel.tuter, password: secret://vault/sn-emp }
  tables: [incident, change_request, sc_req_item]   # snapshot these; update-set changes on parents (task) reach them
  portal: sp
  timeoutMs: 15000
```

Secrets can be `secret://store/key` references or `ENC(...)` values. They are resolved through the Identity Vault only when a request needs them, and they are masked in every log, result and evidence file.

## Phrasings (17 phrasings)

Every phrasing names ServiceNow, so these lines never collide with web lines or with the other add-ons. For example, `Open the ServiceNow incident "INC0010001"` belongs to this pack, while `Open the Account record "X"` belongs to D365.

| Purpose | Phrasings |
|---|---|
| Session | `Log in to ServiceNow as itil` |
| Navigation | `Open the ServiceNow incident list` · `Create a new ServiceNow incident` · `Open the ServiceNow incident "INC0010001"` · `Open the ServiceNow change request "CHG0010001"` |
| Fields and variables | `Set ServiceNow field "Short description" to "Printer jam"` · `Set ServiceNow variable "Model" to "Dell XPS 13"` |
| UI actions | `Submit the ServiceNow form` · `Update the ServiceNow record` · `Click the ServiceNow UI action "Resolve"` · `… and expect the error "Resolution code"` |
| Service Portal | `Open the ServiceNow catalog item "Standard Laptop"` · `Order the ServiceNow catalog item` |
| Checks | `Expect ServiceNow field "State" to be "In Progress"` · `Expect ServiceNow field "Caller" to be mandatory` (also `read-only`, `editable` or `hidden`) · `Expect the ServiceNow info message to contain "created"` · `Expect the ServiceNow error message to contain "…"` · `Expect the ServiceNow related list "Task SLAs" to contain "Priority 3 resolution"` · `Expect the ServiceNow UI action "Resolve" to be hidden` · `Expect the ServiceNow incident list to contain "VPN down"` |
| Table API | `Verify in ServiceNow that incident "INC0010001" has state = "Resolved" and "Assignment group" = "Service Desk"` · `Verify in ServiceNow that requested item "${servicenow.request.items.0}" has variables.model = "dell_xps_13"` |

You can write fields by label (`"Assignment group"`) or by element (`assignment_group`). Records are found by `number`, by `name`, or by a 32-character `sys_id`.

## Ledger and evidence

`${servicenow.number}`, `${servicenow.sysId}`, `${servicenow.table}`, `${servicenow.request.number}`, `${servicenow.request.items}`, `${servicenow.fields.<element>}` and `${servicenow.tableApi.<table>}` hold what the steps saw. Each step stores JSON evidence (the field, the control and its read-back value, the UI action and its messages, the Table API query and checks). The pack also stores screenshots after navigation and actions, and always when a step fails.

## Change impact

```bash
eztest apps snapshot servicenow -o before.json --release "pre-commit"
eztest apps impact servicenow --update-set "Q3 incident changes" --skipped journeys
eztest apps impact servicenow --before before.json --after after.json journeys
```

Each impacted journey lists reasons such as:

- `breaking field-relabeled Short description` (a field label that this journey types changes)
- `breaking values-removed Database` (the journey selects a choice that the update set deletes)
- `breaking field-required creates-record category` (a newly mandatory field that the journey never sets)
- `breaking ui-changed Resolve` (a UI action is deactivated)
- `review skipped-upgrade Resolve` (the upgrade kept your customisation of this UI action)

Changes that no journey touches are listed under `untested`, because they are test gaps. The command exits 1 when any journey breaks.

## Permission matrix

```yaml
# perms.yaml: expect write | read | none (tables, fields), visible | hidden (UI actions)
- { table: incident, expect: { itil: write, employee: read } }
- { table: incident, field: Internal cost, expect: { itil: read, employee: none } }
- { table: change_request, expect: { itil: read, employee: none } }
- { table: incident, uiAction: Delete, expect: { admin: visible, itil: hidden } }
```

```bash
eztest apps permissions servicenow --checks perms.yaml --ui -o perms-report.json
```

The Table API cannot show write access without writing a record. A `write` expectation is therefore checked as `read` on the API side and as an editable form on the UI side (with `--ui`). You can also write `read+` to mean at least read.

## Limits

- The pack drives UI16 forms opened directly as `<table>.do`. It does not drive Next Experience (Polaris, a shadow-DOM workspace) or Workspace forms, and it does not navigate inside the `gsft_main` frame.
- The UI16 form fields it handles are: text and textarea, choice, reference, boolean and journal. It does not handle list collectors, multi-row variable sets or date pickers with their own widgets.
- Upgrade analysis reads `sys_upgrade_history_log`. It does not run the instance's own upgrade preview.
- Update-set classification reads `sys_update_xml` payload XML for the types listed above. It reports other types only when their name points at a configured table.
