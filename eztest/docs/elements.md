# Shared element repository

Define an element once and use it from every journey. Its locators, fingerprint and verified heals live in one place. When the app renames it, one reviewed fix repairs every journey. This is EZTest's counterpart to Katalon's Object Repository, Tosca modules, the UFT object repository, the Ranorex repository and TestComplete Name Mapping.

## Defining elements

Put one screen per file in `elements/`, using `.yaml`, `.yml` or `.json`:

```yaml
# elements/checkout.yaml
screen: Checkout
elements:
  placeOrder:
    description: the "Place order" button
    locators:
      - role=button[name="Place order"]
      - testid=place-order
    aliases: [the Checkout button]
  emptyBasket: the "Empty basket" button        # a description, read like an .ez target
  total: testid=order-total or css=#total         # selectors, tried in order
  cardNumber:
    description: the card number
    locators: [{strategy: label, value: Card number}]
    frames: ['iframe#pay']
```

- The element id is `<screen>.<key>`, for example `Checkout.placeOrder`. Spaces and dots in a screen name become `_`.
- `locators` are tried in order, and only one that matches **exactly one** element is used. A locator can be a selector string (`role=…[name="…"]`, `testid=`, `css=`, `#id`, `xpath=`, `text=`) or an object (`{ strategy, value, name?, exact? }`, with any strategy).
- `description` names the element in reports and healing. Without `locators`, EZTest turns the description into locators, as in `.ez`.
- `aliases` are other descriptions that journeys may use.
- `fingerprint` (optional) seeds the T1 healer before the first run records one.
- `frames` lists the frame chain for an element inside iframes.

An entry that is wrong (not a selector, a bad key, an id defined twice) is reported with its file and line. The other entries still load.

### Screens from code

The SDK's `screen('Checkout', { placeOrder: { role: 'button', name: 'Place order' } })` gives each static entry the id `Checkout.placeOrder`. When `elements/` has that id, the repository's locators come first.

TypeScript screen modules can join the repository directly. Set `elements.screens: [screens]` in the config. EZTest then reads `screen(...)` calls with the TypeScript compiler API, **without running them**: only literal entries count. Function entries (`row: (id) => …`) and computed values stay in code, and EZTest reports them.

Importer plugins can write such modules to `screens/` too. To own the elements as YAML, run:

```bash
eztest elements import-screens            # screens/ -> elements/<Screen>.yaml (never overwrites without --force)
eztest elements import-screens src/screens --dry-run
```

## Using elements in journeys

| Form | Example |
|---|---|
| Reference | `Click the @Checkout.placeOrder button` · `Click @Checkout.placeOrder` · `Expect the @Checkout.total text has text "39.98"` |
| Component phrasings | `Pick 1990-04-15 in the @Pim.dateOfBirth date picker` · `Choose "Berlin" in the @Orders.city combobox` · `Open the "Billing" tab in the @Settings.tabs tabs` · `Sort the @Orders.list grid by Amount` (the element is the widget, or the field or section it sits in) |
| Description or alias | `Click the "Place order" button` or `Click the Checkout button` (matches the element's description or an alias; turn off with `elements.matchDescriptions: false`) |
| Anchor of a relative target | `Click the "Remove" button near @Checkout.total` |
| YAML / JSON | `target: { description: the place order button, element: Checkout.placeOrder }`, or a string step |
| SDK | `ui.click(Checkout.placeOrder)` (from `screen()`), or `ui.click('the @Checkout.placeOrder button')` |

A target bound to an element takes the repository's locators, followed by any locators of its own, plus its fingerprint and frames. A reference to an id the repository does not have fails the step with `element @X is not in the element repository`. `eztest elements unused` also lists such references.

`eztest elements list` and `unused` (and Studio's Project › Elements) count uses in code too, read as text in the project's journeys folder, its `elements.screens` folders and the folders of its `bdd.steps`: a screen model entry (`ui.table(TheInternet.firstTable)` for the screen `screen('TheInternet', {...})`, also when imported under another name) and an `@Screen.element` reference in a string (`ui.click('the @Shop.cart table')`). A screen entry counts when the repository has its id; a string reference to an id it does not have is listed as unknown.

## Healing, once for every journey

- **One memory per element.** The fingerprint store keeps an unscoped repository element under `@elements/<id>`, not under each journey's step. When one journey's step has passed, every journey can heal from that fingerprint. Once one journey's heal is verified, the other journeys reuse it from the T0 cache. A scoped use, such as `the @Orders.edit button in the row containing "Acme"`, keeps a per-step memory, because each row is a different element.
- **Verified first.** As everywhere in EZTest, a heal counts only when the step's expectations hold. Otherwise the step fails as a suspected regression.
- **One review item.** The Quality Center heal inbox (`Quality > Heals`) shows one item per element and healed locator. The item says `Shared element @Checkout.placeOrder … used by Place by alias, Place by reference`.
- **Accept, with a diff first.** **Accept** previews the change to the element's file. The healed locator goes first in `locators`, and an equal locator further down is dropped. YAML comments and layout elsewhere in the file are kept. A short-form entry becomes `{ description, locators }`. An element that comes from a TypeScript screen gets an override entry in `elements/<Screen>.yaml` instead: YAML entries win over screens, and the code is never rewritten. The write is hash-checked against the preview. The decision is recorded in `.eztest/heal-decisions.json`, and the element's memory is reset to the accepted locator.
- **Every journey is fixed at once.** The next run of every journey that uses the element gets the new locator from the repository, without healing.

## Commands

```bash
eztest elements list                 # every element, its locators, file:line and how many journeys use it (--json)
eztest elements unused               # elements no journey and no code uses, and references to unknown elements (exit 1 for unknown; --strict: also for unused)
eztest elements duplicates           # elements that look like one element defined twice: same locators, same first locator, same description (--strict)
eztest elements import-screens [dir] # write elements/<Screen>.yaml from TypeScript screens
```

## Studio

**Project > Elements** lists every element with:

- its locators, the file and line that define it, and whether it has a stored fingerprint;
- its usages per journey and step, and how each journey refers to it (`@reference` or by description; target, expectation or anchor);
- unused elements, unknown references, likely duplicates and loading problems.

## Configuration

```yaml
elements:
  dir: elements            # where elements/*.yaml live (default)
  screens: [screens]       # TypeScript screen modules read statically (default: none)
  matchDescriptions: true  # bind journeys by description / alias (default)
```

From code: `import { elements } from '@eztech.com/eztest'` or `@eztech.com/eztest/elements`. `ElementRepository.load(root, options)` loads a repository. Then `bindJourney(journey, repo)`, `elementUsages(journeys, repo)`, `duplicateElements(repo)` and `planElementHeal(...)` work with it. To use a repository in a run, pass it as `RunOptions.elements`; the engine does this from the config.
