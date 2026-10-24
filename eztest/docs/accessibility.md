# Accessibility

EZTest checks accessibility with **its own engine** (`src/a11y`, `@eztech/eztest/a11y`),
written from the W3C specifications: WCAG 2.2 success criteria, WAI-ARIA 1.2,
HTML-AAM, Accessible Name and Description Computation (accname) 1.2 and the
WCAG relative-luminance contrast formula. It depends on no other testing or
accessibility tool. Accessible names and roles come from the same accname and
HTML-AAM code as EZTest's `role=` / `getByRole` selectors
(`src/browser/injected/page`), so a locator and an accessibility finding never
disagree about what an element is called.

There are three ways to use it:

| Where | What runs | Fails when |
| --- | --- | --- |
| The **a11y lens** (`lenses: [a11y]`, `--lens a11y`, or `a11y:warn` to record only) | The static rules (WCAG 2.0-2.2 A/AA and best practices) after **every** UI step | A violation at or above `serious` |
| The **"Check accessibility"** step | Static rules **plus** the dynamic checks (keyboard walk, reflow, text spacing) at one point of a journey | A violation at or above `serious` (configurable) |
| The API: `scanAccessibility(page, options)` from `@eztech/eztest/a11y` (or `@eztech/eztest/lenses`) | What the options select | You decide |

Results are stored as evidence (`lenses/a11y/...json` for the lens,
`a11y/<journey>/lens-a11y-<step>.json` for the step). Studio's
**Assurance > Accessibility** page lists them by rule and impact, with the WCAG
criteria and the offending elements outlined on the step screenshot, and the
readiness gate `a11yNoCritical` reads them (see [Release readiness](#release-readiness)).

## The "Check accessibility" step

```
Check accessibility
Check the page for accessibility issues at WCAG 2.2 level AA
Check accessibility of the Checkout form without dynamic checks
Audit accessibility to level AAA including best practices
Scan for accessibility violations failing on critical issues
Expect the page to be accessible
```

* **Level** (`at`/`to level A|AA|AAA`, default AA): every WCAG rule at that level or below.
  Best practices are added with `including best practices`.
* **Scope** (`of`/`in the <target>`): only nodes inside that element (any EZTest target phrase).
* `without dynamic checks` skips the keyboard walk, reflow and text spacing.
* `failing on <impact>` sets the impact that fails the step (default `serious`).

The step is its own step (never a post-condition of the line above) and
renders back to `.ez` text as `Run step "eztest.a11y" with level="AA"`.

## The API

```ts
import { scanAccessibility } from '@eztech/eztest/a11y';

const r = await scanAccessibility(page, {
  level: 'AA',                 // or tags: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice']
  include: ['#checkout'],      // CSS selectors; " >>> " pierces shadow roots
  exclude: ['.third-party-widget'],
  disableRules: ['landmark.contained'],
  minImpact: 'serious',
  dynamic: { keyboard: true, reflow: true, textSpacing: true }, // or true; off by default
});
r.violations;   // A11yFinding[]: ruleId, impact, help, description, helpUrl, sc, tags, nodes, nodeCount
r.needsReview;  // same shape: what a person has to judge (gradients, media, layout tables ...)
r.passes;       // rules that applied and found nothing
r.counts;       // violations by impact
r.totals;       // node counts: violations, needsReview, passes
```

Each node has a `target` (selector path: one entry per frame, shadow-root hops
joined with ` >>> `), the start tag (`html`), a `failureSummary` that explains
this particular failure (for example *"Contrast is 2.32:1 (#aaaaaa on #ffffff,
16px); at least 4.5:1 is required."*) and its `box` in document coordinates.

### Selecting rules

| Option | Selects |
| --- | --- |
| *(none)* | WCAG A and AA rules of every version, plus best practices |
| `level: 'A' \| 'AA' \| 'AAA'` | WCAG rules at that level or below (`bestPractice: false` drops best practices) |
| `tags` | Rules carrying any of the tags. Level tags name the WCAG version that introduced the criterion: `wcag2a`, `wcag2aa`, `wcag2aaa` (2.0), `wcag21a`, `wcag21aa` (2.1), `wcag22aa` (2.2). Also `wcag22` (every rule mapped to a WCAG 2.2 criterion), per-criterion tags such as `wcag143`, `best-practice`, `cat.<category>`, `dynamic` |
| `rules` | Exactly these rule ids |
| `disableRules` | Everything else that was selected |

Dynamic rules run only when `dynamic` is set (the "Check accessibility" step
sets it). AAA rules (`contrast.text-enhanced`, `target.size-enhanced`) run only
with `level: 'AAA'` or their tags.

## How it runs

* **One evaluation per document.** The engine is bundled once
  (`dist/a11y/a11y.bundle.js`, or built from source with esbuild) and installed
  in the page's main world through EZTest's driver (CDP or WebDriver BiDi);
  `scanAccessibility` then runs all selected rules in a single call. It works
  under a strict Content-Security-Policy (nothing is injected as a script tag).
* **Shadow DOM**: open shadow roots are traversed (flat tree for names and
  roles, shadow-including order for structure).
* **Frames**: same-origin frames are scanned from their parent document;
  cross-origin and sandboxed frames are scanned through the driver's frame
  list, and their nodes are prefixed with the selector of each `<iframe>` on the
  way, with boxes offset into top-document coordinates.
* **Dynamic checks** (only when asked):
  * *Keyboard walk*: presses Tab with the driver's keyboard from the top of the
    page, up to `maxTabStops` (80) times or until the last tab stop. A cycle
    that leaves other tab stops unreachable is a keyboard trap
    (`keyboard.trap`), unless it is inside an open modal dialog. At each stop it
    compares the element's rendering (outline, shadow, border, background,
    colour, pseudo-elements, parent) with its unfocused rendering
    (`focus.visible`), checks the stop is visible (`focus.hidden-stop`), not
    entirely covered (`focus.not-obscured`), and flags moves back up and to the
    left for review (`focus.order`). Focus and scroll position are restored.
  * *Reflow*: sets the viewport to 320 CSS px wide, measures horizontal
    overflow and names the innermost overflowing elements (tables, code, media
    and other two-dimensional content are reported for review only), then
    restores the viewport.
  * *Text spacing*: applies the 1.4.12 values (line height 1.5, letter spacing
    0.12em, word spacing 0.16em, paragraph spacing 2em) to every document and
    shadow root, reports text that is newly cut off by `overflow: hidden`, and
    removes the overrides in the same call.
* **Contrast**: foreground and background colours come from computed styles
  (any CSS colour syntax, resolved through a canvas), with opacity and
  transparency composited. The background is taken from the hit-test stack when
  a positioned element overlaps the text, otherwise from the ancestor chain.
  Text over a gradient passes when every gradient stop passes, otherwise it
  needs review, as does text over images, embedded content, blend modes or
  overlapping elements. Positioned `::before` / `::after` boxes that paint a
  background near the text are measured too: when the text passes against
  one background and fails against the other it needs review. Placeholder
  text of empty fields is measured with its `::placeholder` colour. Large text
  is 24px, or 18.66px bold. Disabled controls are exempt.
* **ARIA in HTML**: explicit roles are checked against the roles the W3C ARIA
  in HTML Recommendation allows on each element (`aria.role-allowed`), and
  elements with no ARIA role may only carry global `aria-*` attributes (plus
  the few ARIA in HTML allows on some input types).
* **Performance**: a 16,600-element page (1,500-row table, 1,000 links, 400
  fields, 200 shadow components) runs all static rules in about 1.3 s
  (1 s in the page) on a lightly loaded machine, and 6-10 s with the machine
  heavily loaded; `test/a11y/perf.test.ts` holds it under 15 s.

## Outcomes

* **Violation**: the rule fails for the node. Impact `critical`, `serious`,
  `moderate` or `minor` is set per rule.
* **Needs review**: the engine cannot decide (a gradient background, a video's
  captions, a table that may be layout, a focus move that may be intended).
  These never fail a lens or step; Studio shows the count.
* **Pass** / **inapplicable**: per rule, counted.

## Release readiness

`a11yNoCritical` (`gates: { a11yNoCritical: true }` or
`{ impacts: [critical, serious] }`) now reads the findings the run recorded:
every violated rule of every scanned step, citing that step's evidence file.
A run with no accessibility evidence reports *no data*; a run whose scans found
nothing passes. Both `eztest run --policy` / `eztest analyze` and Studio's
Quality > Release readiness use it.

## Rules

79 rules. *Level* is the lowest conformance level among the criteria;
best-practice rules support the criteria shown but are not required by them.
Help texts and failure explanations are EZTest's own; each finding links to the
W3C *Understanding* page of its first criterion (or the WAI-ARIA / HTML section).

### Text alternatives

| Rule | WCAG 2.2 success criteria | Level | Impact | Checks |
| --- | --- | --- | --- | --- |
| `text-alt.img` | 1.1.1 Non-text Content | A | critical | Every informative image has a text alternative; decorative images have `alt=""` |
| `text-alt.area` | 1.1.1 Non-text Content, 2.4.4 Link Purpose (In Context) | A | critical | Every linked area of an image map has a text alternative |
| `text-alt.input-image` | 1.1.1 Non-text Content, 4.1.2 Name, Role, Value | A | critical | Image buttons (`<input type="image">`) say what they do |
| `text-alt.role-img` | 1.1.1 Non-text Content | A | serious | Elements exposed as images (role="img", `<svg role="img">`) have an accessible name |
| `text-alt.object` | 1.1.1 Non-text Content | A | serious | Embedded objects have a text alternative |

### Names and labels

| Rule | WCAG 2.2 success criteria | Level | Impact | Checks |
| --- | --- | --- | --- | --- |
| `name.button` | 4.1.2 Name, Role, Value | A | critical | Buttons have an accessible name |
| `name.link` | 2.4.4 Link Purpose (In Context), 4.1.2 Name, Role, Value | A | serious | Links have an accessible name |
| `name.form-field` | 4.1.2 Name, Role, Value, 3.3.2 Labels or Instructions | A | critical | Form fields have a label |
| `name.widget` | 4.1.2 Name, Role, Value | A | serious | Widgets whose role requires a name have one |
| `name.container` | 4.1.2 Name, Role, Value | best practice | moderate | Composite widgets and regions whose role requires a name have one |
| `name.frame` | 4.1.2 Name, Role, Value | A | serious | Frames have a title or another accessible name |
| `name.label-in-name` | 2.5.3 Label in Name | A | serious | The accessible name of a control contains its visible label |
| `frame.title-unique` | 4.1.2 Name, Role, Value | best practice | minor | Frames showing different content have different titles |

### Forms

| Rule | WCAG 2.2 success criteria | Level | Impact | Checks |
| --- | --- | --- | --- | --- |
| `label.visible` | 3.3.2 Labels or Instructions | A | moderate | Form fields have a visible label, not only a placeholder or tooltip |
| `label.for-target` | 1.3.1 Info and Relationships | best practice | moderate | label[for] points to an existing form control |
| `form.autocomplete` | 1.3.5 Identify Input Purpose | AA | serious | autocomplete attributes use the tokens defined by HTML |

### WAI-ARIA

| Rule | WCAG 2.2 success criteria | Level | Impact | Checks |
| --- | --- | --- | --- | --- |
| `aria.role-valid` | 4.1.2 Name, Role, Value | A | critical | role attributes hold at least one valid, non-abstract WAI-ARIA role |
| `aria.attr-name` | 4.1.2 Name, Role, Value | A | critical | aria-* attributes are defined by WAI-ARIA |
| `aria.attr-value` | 4.1.2 Name, Role, Value | A | critical | aria-* attributes have values of their type (true/false, token, number, ID reference) |
| `aria.attr-required` | 4.1.2 Name, Role, Value | A | critical | Elements with a role have the states and properties that role requires |
| `aria.attr-allowed` | 4.1.2 Name, Role, Value | A | serious | aria-* attributes are supported by the role of the element |
| `aria.attr-prohibited` | 4.1.2 Name, Role, Value | A | serious | Elements whose role prohibits naming have no aria-label or aria-labelledby |
| `aria.reference` | 4.1.2 Name, Role, Value, 1.3.1 Info and Relationships | A | serious | ARIA ID references point to elements that exist |
| `aria.parent` | 1.3.1 Info and Relationships | A | critical | Roles that need a particular parent are inside it |
| `aria.children` | 1.3.1 Info and Relationships | A | critical | Roles that need particular children own them |
| `aria.hidden-focusable` | 4.1.2 Name, Role, Value | A | serious | Content hidden with aria-hidden="true" cannot receive keyboard focus |
| `aria.hidden-body` | 4.1.2 Name, Role, Value | A | critical | aria-hidden="true" is not set on the document body or root |
| `aria.nested-interactive` | 4.1.2 Name, Role, Value | A | serious | Controls whose children are presentational contain no focusable elements |
| `aria.role-allowed` | 4.1.2 Name, Role, Value | best practice | moderate | Explicit roles are ones ARIA in HTML allows on that element |
| `aria.presentation-conflict` | 4.1.2 Name, Role, Value | best practice | minor | role="none"/"presentation" is not used on focusable elements or elements with global ARIA attributes |
| `aria.deprecated` | 4.1.2 Name, Role, Value | best practice | minor | Deprecated WAI-ARIA roles and attributes are not used |

### Colour and contrast

| Rule | WCAG 2.2 success criteria | Level | Impact | Checks |
| --- | --- | --- | --- | --- |
| `contrast.text` | 1.4.3 Contrast (Minimum) | AA | serious | Text contrasts with its background at least 4.5:1 (3:1 for large text) |
| `contrast.text-enhanced` | 1.4.6 Contrast (Enhanced) | AAA | serious | Text contrasts with its background at least 7:1 (4.5:1 for large text) |
| `contrast.ui-component` | 1.4.11 Non-text Contrast | AA | serious | The boundary of form fields contrasts at least 3:1 with what surrounds it |
| `contrast.link-in-text` | 1.4.1 Use of Color | A | serious | Links inside text are distinguishable by more than colour alone |

### Document structure

| Rule | WCAG 2.2 success criteria | Level | Impact | Checks |
| --- | --- | --- | --- | --- |
| `page.title` | 2.4.2 Page Titled | A | serious | The document has a non-empty `<title>` |
| `heading.order` | 1.3.1 Info and Relationships | best practice | moderate | Heading levels increase by one at a time |
| `heading.empty` | 2.4.6 Headings and Labels | best practice | moderate | Headings have text |
| `heading.level-one` | 1.3.1 Info and Relationships | best practice | moderate | The page has a level-one heading |
| `landmark.main` | 1.3.1 Info and Relationships | best practice | moderate | The page has a main landmark |
| `landmark.single` | 1.3.1 Info and Relationships | best practice | moderate | The page has at most one main, banner and contentinfo landmark |
| `landmark.top-level` | 1.3.1 Info and Relationships | best practice | moderate | main, banner and contentinfo landmarks are not nested in other landmarks |
| `landmark.unique` | 1.3.1 Info and Relationships | best practice | moderate | Landmarks of the same kind have different names |
| `landmark.contained` | 1.3.1 Info and Relationships | best practice | moderate | All visible content is inside a landmark |

### Language

| Rule | WCAG 2.2 success criteria | Level | Impact | Checks |
| --- | --- | --- | --- | --- |
| `lang.page` | 3.1.1 Language of Page | A | serious | The `<html>` element has a lang attribute |
| `lang.valid` | 3.1.1 Language of Page, 3.1.2 Language of Parts | A | serious | lang attributes hold well-formed BCP 47 language tags |

### Navigation

| Rule | WCAG 2.2 success criteria | Level | Impact | Checks |
| --- | --- | --- | --- | --- |
| `bypass.blocks` | 2.4.1 Bypass Blocks | A | serious | The page offers a way to skip repeated blocks (a main landmark, headings or a skip link) |
| `bypass.skip-link` | 2.4.1 Bypass Blocks | A | moderate | Skip links point to an element on the page |

### IDs

| Rule | WCAG 2.2 success criteria | Level | Impact | Checks |
| --- | --- | --- | --- | --- |
| `id.duplicate-referenced` | 4.1.2 Name, Role, Value, 1.3.1 Info and Relationships | A | serious | IDs used by labels and ARIA references are unique |
| `id.duplicate` | 4.1.2 Name, Role, Value | best practice | minor | id attributes are unique in their document or shadow root |

### Tables

| Rule | WCAG 2.2 success criteria | Level | Impact | Checks |
| --- | --- | --- | --- | --- |
| `table.headers-attr` | 1.3.1 Info and Relationships | A | serious | The headers attribute of a cell names header cells of the same table |
| `table.scope` | 1.3.1 Info and Relationships | best practice | moderate | scope is used on `<th>` only, with row, col, rowgroup or colgroup |
| `table.has-headers` | 1.3.1 Info and Relationships | A | serious | Data tables mark their header cells |
| `table.header-empty` | 1.3.1 Info and Relationships | best practice | minor | Table header cells have text |
| `table.caption` | 1.3.1 Info and Relationships | best practice | minor | Data tables have a caption or accessible name |

### Lists

| Rule | WCAG 2.2 success criteria | Level | Impact | Checks |
| --- | --- | --- | --- | --- |
| `list.structure` | 1.3.1 Info and Relationships | A | serious | `<ul>` and `<ol>` contain only `<li>`, `<script>` and `<template>` children |
| `list.item-context` | 1.3.1 Info and Relationships | A | serious | `<li>` elements are inside a `<ul>`, `<ol>` or `<menu>` (or role="list") |
| `list.definition` | 1.3.1 Info and Relationships | A | serious | Description lists contain only `<dt>/<dd>` groups, and `<dt>/<dd>` are inside a `<dl>` |

### Keyboard and focus

| Rule | WCAG 2.2 success criteria | Level | Impact | Checks |
| --- | --- | --- | --- | --- |
| `focus.tabindex-positive` | 2.4.3 Focus Order | best practice | serious | No element has a tabindex greater than 0 |
| `keyboard.scrollable` | 2.1.1 Keyboard | A | moderate | Scrollable regions can be reached with the keyboard |
| `keyboard.frame-tabindex` | 2.1.1 Keyboard | A | serious | Frames with focusable content are not removed from the tab order |
| `keyboard.trap` | 2.1.2 No Keyboard Trap | A | critical | Focus can move away from every component with Tab / Shift+Tab (dynamic: keyboard) |
| `focus.visible` | 2.4.7 Focus Visible | AA | serious | Elements show a visible focus indicator when reached with the keyboard (dynamic: keyboard) |
| `focus.hidden-stop` | 2.4.7 Focus Visible, 2.4.3 Focus Order | A | serious | Every tab stop is visible when it has focus (dynamic: keyboard) |
| `focus.order` | 2.4.3 Focus Order | A | moderate | The tab order follows the reading order (dynamic: keyboard) |
| `focus.not-obscured` | 2.4.11 Focus Not Obscured (Minimum) | AA | serious | A focused element is not entirely hidden by other content (dynamic: keyboard) |

### Layout, zoom and pointer

| Rule | WCAG 2.2 success criteria | Level | Impact | Checks |
| --- | --- | --- | --- | --- |
| `target.size` | 2.5.8 Target Size (Minimum) | AA | serious | Pointer targets are at least 24 by 24 CSS pixels, or spaced so a 24px circle around each does not touch another |
| `target.size-enhanced` | 2.5.5 Target Size (Enhanced) | AAA | moderate | Pointer targets are at least 44 by 44 CSS pixels |
| `zoom.viewport` | 1.4.4 Resize Text | AA | critical | The viewport meta tag does not disable zooming |
| `layout.orientation` | 1.3.4 Orientation | AA | serious | Content is not locked to portrait or landscape with CSS |
| `layout.reflow` | 1.4.10 Reflow | AA | serious | At 320 CSS pixels wide, content reflows without horizontal scrolling (dynamic: reflow) |
| `text.spacing` | 1.4.12 Text Spacing | AA | serious | No text is cut off when line, letter, word and paragraph spacing are increased (dynamic: textSpacing) |

### Timing and motion

| Rule | WCAG 2.2 success criteria | Level | Impact | Checks |
| --- | --- | --- | --- | --- |
| `timing.meta-refresh` | 2.2.1 Timing Adjustable | A | critical | The page does not refresh or redirect itself on a timer |
| `motion.blink` | 2.2.2 Pause, Stop, Hide | A | serious | `<blink>` is not used |
| `motion.marquee` | 2.2.2 Pause, Stop, Hide | A | serious | `<marquee>` is not used |

### Media

| Rule | WCAG 2.2 success criteria | Level | Impact | Checks |
| --- | --- | --- | --- | --- |
| `media.captions` | 1.2.2 Captions (Prerecorded) | A | critical | Videos with sound have captions |
| `media.audio-description` | 1.2.5 Audio Description (Prerecorded) | AA | moderate | Videos have an audio description of important visual information |
| `media.audio-alternative` | 1.2.1 Audio-only and Video-only (Prerecorded) | A | serious | Audio-only content has a transcript |
| `media.autoplay` | 1.4.2 Audio Control | A | moderate | Audio that plays automatically for more than 3 seconds can be paused or muted |

## Known limits

* No check can establish conformance on its own: needs-review items, and
  criteria that need judgement (meaningful sequence, consistent navigation,
  error suggestions, captions quality ...), need a person.
* Closed shadow roots are not visible to the engine.
* `include` / `exclude` selectors are resolved in the top document; a
  cross-origin frame is included or excluded as a whole (by its `<iframe>`
  selector).
* Text shadows are not measured (a failing ratio with a shadow is reported for
  review); a pseudo-element's exact geometry is not known, so a disagreement
  between its background and the element's is reported for review.
* Doc-* (DPUB) and graphics-* roles are accepted on any element that takes a role.
* The keyboard walk presses Tab only (not Shift+Tab) and stops at the last tab
  stop of the page (pressing Tab there would move focus to the browser UI), so a
  trap that includes the very last stop is not detected; a visually hidden
  control is judged through its visible `<label>`.
* The reflow and keyboard checks change the viewport and focus while they run
  and restore them afterwards; pages that react to resizes (re-render, close
  menus) may end in a different state. That is why they are off in the lens.

## Migrating from the previous engine

Earlier versions injected a third-party engine. Results keep their shape
(`violations`, `incomplete`, `passes`, `counts`, nodes with `target`, `html`,
`failureSummary`, `box`), with these changes:

* Rule ids are EZTest's own (`text-alt.img`, `name.button`, `contrast.text` ...);
  update `disableRules` lists accordingly. Unknown ids are rejected.
* `axeVersion` is replaced by `engine` (`"eztest-a11y/1.0.0"`).
* `needsReview` lists the items to review (`incomplete` is their count);
  each finding has `outcome`, `sc` (its WCAG criteria) and `nodeCount`.
* `helpUrl` points to the W3C Understanding documents.
