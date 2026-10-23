# Workday pack

The Workday pack drives Workday tasks, prompts, related actions and the business process inbox in plain English. It cross-checks data through WQL, REST and SOAP. It also reports which journeys a semi-annual release (tested on a preview tenant) breaks, and checks task and data-source access per role.

> **Tested against a mock, not a real tenant.** Every test of this pack runs against `examples/workday-mock`. That mock is an emulation we built from Workday's public conventions (`data-automation-id` attributes, prompts, the segmented date widget, related actions and the inbox) and its public APIs (REST, WQL, SOAP Human_Resources, RaaS). It is not Workday, and the pack has not been run against a real tenant. Before you rely on the pack, run it against an implementation tenant.

Source: `src/apps/workday/`. Tests: `test/apps/workday.test.ts`.

## What it covers

| Capability | How |
|---|---|
| Fields by label | A form row is found by its `formLabel`. The widget is detected from the row: prompts (`multiselectInputContainer`: type, Enter, an exact `promptOption`, then the `selectedItem` pill is checked), the date widget (`dateSectionMonth`, `Day` and `Year` sections; ISO or MM/DD/YYYY), text inputs and checkboxes. |
| Tasks and people | Global search (`globalSearchInput`): tasks and people are matched exactly. |
| Related actions | The related-actions button opens a menu of categories and actions, written `"Job Change > Change Job"`. |
| Business process | Submit, then the error bar (`errorWidgetBarMessage`) or the confirmation page (`You have submitted`, `Up Next: ...`). The inbox item is opened and then approved or sent back. |
| WQL cross-check | Field descriptors (labels) are resolved through `dataSources/{ds}/fields`. WQL is built from validated aliases and quoted literals (`'O''Brien'`), and instance values are compared by descriptor. |
| SOAP cross-check | `Human_Resources` `Get_Workers` by `Employee_ID`, with a WS-Security UsernameToken for the integration system user. The response is flattened to element names such as `Business_Title`, `Hire_Date` and `Formatted_Name`. |
| Release impact | Snapshots of production and the preview tenant: WQL field descriptors, plus the configured task forms crawled in the preview (field ids, labels, widgets, required flags, prompt options). The **What's New in Workday** report (a RaaS custom report) adds renamed fields, newly required fields, retired values and UI changes per task. |
| Permission matrix | Task availability through global search, signed in as each user, and data-source access through WQL as each user. |

This pack is aimed at the Workday automation that Functionize, ACCELQ, Tosca and Kainos Smart offer: tasks and business processes in plain language, plus release-preview regression scoping.

## Configuration

```yaml
workday:
  url: https://wd2-impl-services1.workday.com        # API host
  uiUrl: https://wd2-impl.workday.com/ezcorp          # UI root (default <url>/<tenant>)
  tenant: ezcorp
  auth:                                                # an API client for integrations (refresh token grant)
    type: oauth2
    grant: refresh_token
    tokenUrl: https://wd2-impl-services1.workday.com/ccx/oauth2/ezcorp/token
    clientId: ZWU1ZjI2...
    clientSecret: secret://vault/wd-client-secret
    refreshToken: secret://vault/wd-refresh-token
  isu: { username: ISU_EZTest@ezcorp, password: secret://vault/wd-isu }   # SOAP
  users:
    hr: { username: bliu, password: secret://vault/wd-hr }
    manager: { username: lmcneil, password: secret://vault/wd-mgr }
  dataSources: [allWorkers]
  tasks: [Hire Employee, Change Job]                   # crawled for release snapshots
  whatsNewReport: { owner: ISU_EZTest, name: Whats_New_in_Workday }
```

## Phrasings (16 phrasings)

Every phrasing names Workday.

| Purpose | Phrasings |
|---|---|
| Session and navigation | `Log in to Workday as hr` · `Open the Workday task "Hire Employee"` · `Open the Workday worker "Alex Jones"` · `Run the Workday related action "Job Change > Change Job"` |
| Fields | `Set Workday field "Hire Date" to "2026-11-02"` · `Set Workday field "Job Profile" to "Software Engineer"` (prompt) |
| Business process | `Submit the Workday task` · `Submit the Workday task and expect the error "The field Effective Date is required"` · `Open the Workday inbox item "Hire: Ada Lovelace"` · `Approve the Workday inbox item` · `Send back the Workday inbox item` |
| Checks | `Expect the Workday confirmation to contain "You have submitted"` · `Expect the Workday error to contain "is required"` · `Expect Workday field "Business Title" to be "Software Engineer"` · `Expect Workday field "Time Type" to be mandatory` · `Expect the Workday task "Hire Employee" to be unavailable` · `Expect the Workday inbox to contain "Hire: Ada Lovelace"` · `Expect the Workday inbox not to contain "Hire: Ada Lovelace"` |
| APIs | `Verify in Workday that worker "Ada Lovelace" has "Worker Status" = "Active" and "Hire Date" = "2026-11-02"` · `Verify in Workday SOAP that employee "21004" has Business_Title = "Software Engineer" and Active = "1"` |

## Release impact

```bash
eztest apps snapshot workday -o 2026R1.json --release 2026R1 --tasks-as hr       # production
eztest apps snapshot workday -o 2026R2.json --release 2026R2 --tasks-as hr -c preview.config.yaml
eztest apps impact workday --before 2026R1.json --after 2026R2.json --whats-new --release 2026R2 journeys
```

A preview-tenant comparison reports reasons such as these:

- `breaking field-relabeled Reason`: the field is now labelled Hire Reason.
- `breaking values-removed Contractor`: the journey picks a retired Employee Type.
- `breaking field-required creates-record timeType`: Time Type became required and the journey never sets it.
- `breaking field-relabeled Job Profile`: a WQL descriptor that a cross-check uses has changed.

Field identity across releases comes from the form row's `data-automation-id` (`formField-<id>`). Where that is not stable, a relabel shows up as a field removed and a field added.

## Permission matrix

```yaml
- { task: Hire Employee, expect: { hr: available, manager: unavailable, employee: unavailable } }
- { dataSource: allWorkers, expect: { hr: read, employee: none } }
```

## Limits

- Prompts are driven by searching and then picking an exact option. The pack does not navigate hierarchical prompt categories (`By Supervisory Organization > ...`); search for the leaf instead.
- The date widget is handled through its three sections. The pack does not handle time-of-day widgets, rich text, attachments or grid (table) edits.
- Security analysis covers task availability and data-source access per user. The pack does not read domain security policies or security groups themselves.
- What's New ingestion expects a RaaS report with the columns `Change_Type`, `Tasks_Affected`, `Field`, `New_Value`, `Feature` and `Description`. Your tenant's report definition may differ.
