# Power Apps canvas pack

The Power Apps pack drives canvas apps in the Power Apps player by **control name** (`txtName`, `galAccounts`, `btnSave`) in plain English. It reads Power Fx-visible properties and asserts on them with Power Fx expressions, and it cross-checks Dataverse by reusing the Dynamics 365 add-on. It also reports which journeys an app version or a Dataverse release wave breaks, and checks app sharing and control visibility per user. Model-driven apps are covered by the [D365 add-on](../../README.md).

> **Tested against a mock, not a real environment.** Every test of this pack runs against `examples/powerapps-mock`, which embeds the Dataverse mock from `examples/d365-mock`. That mock is an emulation we built from the public conventions of the canvas player (an app iframe named `fullscreen-app-host`, controls with `data-control-name`, gallery items, notifications) and of Microsoft Entra sign-in pages. Its object model is shaped like the binding contexts that the open-source Power Apps Test Engine reads. It is not Power Apps, and the pack has not been run against a real environment. Before you rely on the pack, run it against a developer environment.

Source: `src/apps/powerapps/`. Tests: `test/apps/powerapps.test.ts` and `test/apps/cli-apps.test.ts`.

## What it covers

| Capability | How |
|---|---|
| Controls by name | Controls on the active screen, inside the player frame, found by `data-control-name`. Gallery children are excluded unless the step addresses an item. Supported controls: text inputs, buttons (Power Fx `Select()`), dropdowns and combo boxes (an exact item), toggles and checkboxes. |
| Properties | Read through the app's object model: `AppMagic.Controls.GlobalContextManager.bindingContext.controlContexts[name].modelProperties[prop].getValue()`. The pack only reads, and it runs in the app frame. The properties read are Text, Default, HintText, Visible, DisplayMode, Value, Selected, Items and AllItems, plus `App.ActiveScreen`. Without the object model, the same values come from the DOM. The step evidence says which source was used (`bridge: object-model` or `dom`). |
| Galleries | Items by number, or by a child control's value (`where "lblAccountName" is "Fabrikam"`, an exact match). Item counts and contents come from `AllItems`. |
| Power Fx assertions | A small deterministic evaluator (`src/apps/powerapps/powerfx.ts`). It parses to an AST and evaluates against the property snapshot, so nothing is run as JavaScript. It supports literals, `Control.Property`, record fields (`'Quoted Names'`), `DisplayMode.*`, `= <> < > <= >=`, `& + - * /`, `! Not && And || Or`, `CountRows`, `IsBlank`, `IsEmpty`, `Len`, `Text`, `Value`, `Lower`, `Upper`, `Trim`, `If`, `First`, `Last` and `Concatenate`. |
| Notifications | `Notify()` banners (success and error). |
| Dataverse cross-check | `Verify in Dataverse that account "Fabrikam" has "Main Phone" = "555-0199"`. This is the D365 add-on's own step and phrasing: it resolves the Dataverse metadata (labels to logical names), runs the formatted-value query and compares the values. The pack contributes it only when there is no `d365:` block; when there is one, the D365 add-on provides it. |
| App-version impact | The app's Power Apps source YAML (`.pa.yaml`, from `pac canvas unpack` or source control) is diffed between versions. The diff finds removed, added and **renamed** controls (same type and formulas under a new name), retyped controls, text changes and formula changes. |
| Dataverse impact | A release-wave metadata diff from the D365 add-on (`snapshotMetadata` and `diffMetadata`, reused) is mapped onto the controls whose formulas use a changed column. It is also mapped onto `Patch()` calls that do not set a newly required column. |
| Permission matrix | App sharing roles (Owner, CanEdit, CanView) through `/providers/Microsoft.PowerApps/apps/{app}/permissions`, whether the player opens or denies, and control visibility and DisplayMode as each user. |

This pack is aimed at **Power Apps Test Engine** (canvas apps tested through the player's object model, with Power Fx tests) and goes further: plain-English steps, Dataverse cross-checks, change impact and a sharing matrix.

## Configuration

```yaml
powerapps:
  apps:
    - { name: Account Manager, url: "https://apps.powerapps.com/play/e/<environment-id>/a/<app-id>?tenantId=<tenant>", appId: <app-id> }
  users:
    maker: { username: megan@contoso.com, password: secret://vault/pa-maker }
    user: { username: alex@contoso.com, password: secret://vault/pa-user }
  dataverse:                                   # reuses the D365 DataverseClient
    url: https://contoso.crm.dynamics.com
    tenantId: <tenant-id>
    clientId: <app-registration-id>
    clientSecret: secret://vault/dataverse
    entities: [account]
  api:                                         # app permissions (optional)
    url: https://api.powerapps.com
    tenantId: <tenant-id>
    clientId: <app-registration-id>
    clientSecret: secret://vault/pa-api
```

Users sign in through the Entra pages (`#i0116`, `#i0118`, `#idSIButton9`, and "Stay signed in?" No). Accounts that need MFA or conditional access cannot sign in this way. Use test accounts excluded from those policies.

## Phrasings (13 phrasings, plus the D365 Dataverse phrasing)

Every phrasing names Power Apps or Power Fx.

| Purpose | Phrasings |
|---|---|
| Session and app | `Log in to Power Apps as maker` · `Open the Power Apps app "Account Manager"` |
| Controls | `Set Power Apps control "txtName" to "Contoso"` · `Set Power Apps control "ddIndustry" to "Consulting"` · `Select Power Apps control "btnSave"` |
| Galleries | `Select item 2 in Power Apps gallery "galAccounts"` · `In Power Apps gallery "galAccounts", select the item where "lblAccountName" is "Fabrikam"` |
| Checks | `Expect Power Apps control "lblStatus".Text to be "Saved"` · `Expect Power Apps property "lblStatus.Text" to be "Saved"` · `Expect Power Apps control "btnDelete" to be hidden` (also `visible`, `disabled`, `enabled` or `read-only`) · `Expect Power Apps gallery "galAccounts" to have 3 items` · `Expect Power Apps gallery "galAccounts" to contain "Fabrikam"` · `Expect the Power Apps notification to contain "saved"` · `Expect the Power Apps screen to be "EditScreen"` |
| Power Fx | ``Expect Power Fx `CountRows(galAccounts.AllItems) = 3` `` · `Expect Power Fx 'lblStatus.Text = "Saved" And Len(txtName.Text) > 3'` |
| Dataverse (the D365 phrasing) | `Verify in Dataverse that account "Fabrikam" has "Main Phone" = "555-0199" and "Industry" = "Consulting"` |

Write Power Fx in backticks or single quotes, so that its own double-quoted strings stay intact.

## Change impact

```bash
eztest apps impact powerapps --app-before src/v1/App.pa.yaml --app-after src/v2/App.pa.yaml journeys
eztest apps snapshot powerapps --dataverse -o wave-before.json            # Dataverse metadata (D365 format)
eztest apps impact powerapps --app-after src/App.pa.yaml --dataverse-before wave-before.json --dataverse-after wave-after.json journeys
```

Example reasons:

- `breaking field-relabeled txtName`: the control is renamed `txtAccountName`.
- `breaking field-removed ddIndustry`: the detail adds that `cmbIndustry (ComboBox)` looks like its replacement.
- `breaking logic-changed btnSave`: btnSave patches account without "Account Number", which is now required.
- `review logic-changed txtPhone`: the control shows a column that was relabeled.

## Permission matrix

```yaml
- { app: Account Manager, expect: { maker: owner, user: can-view, guest: none } }
- { control: btnDelete, expect: { maker: disabled, user: hidden } }
```

## Limits

- The object model is read through one shape, the binding contexts that Power Apps Test Engine reads. We have checked it only against our mock. If a player build exposes a different shape, the pack falls back to the DOM, where Visible, DisplayMode, Text, toggle state and gallery item texts are still available.
- The control kinds handled are text inputs, buttons, labels, galleries, dropdowns and combo boxes, toggles and checkboxes. The pack does not handle date pickers with calendars, forms (`EditForm` cards), pen input, components, custom pages or PCF controls.
- The Power Fx evaluator is an assertion subset, not the Power Fx language. It has no data-source functions (`Filter`, `LookUp`, `Patch`), no variables (they are not observable) and no behaviour functions.
- Dataverse privilege checks per security role are not implemented. The matrix covers app sharing and what the app shows each user.
