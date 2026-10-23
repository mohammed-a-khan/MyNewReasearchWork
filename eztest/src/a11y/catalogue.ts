/**
 * EZTest's accessibility rules: our own IDs, the WCAG 2.2 success criteria
 * each one checks, its impact, and the help and description texts shown in
 * reports and Studio. The checks themselves run in the page (./page/).
 *
 * Rules with `bestPractice` check advice from WAI-ARIA 1.2 / HTML-AAM and
 * the WCAG techniques that no single success criterion requires; their `sc`
 * names the criterion they support, and they carry the "best-practice" tag
 * instead of a conformance-level tag.
 */
import { levelTag, scTag, criterion, understandingUrl, type WcagLevel } from './wcag.js';

export type A11yImpact = 'minor' | 'moderate' | 'serious' | 'critical';
export const IMPACT_ORDER: A11yImpact[] = ['minor', 'moderate', 'serious', 'critical'];

export type RuleCategory =
  | 'text-alternatives' | 'names-and-labels' | 'aria' | 'color' | 'structure' | 'language' | 'navigation'
  | 'tables' | 'lists' | 'keyboard-and-focus' | 'forms' | 'media' | 'timing-and-motion' | 'layout' | 'ids';

/** Checks that need the driver (keyboard, viewport) or temporarily restyle the page. Off unless `dynamic` is set. */
export type DynamicKind = 'keyboard' | 'reflow' | 'textSpacing';

export interface RuleMeta {
  id: string;
  /** One line: what must be true. */
  help: string;
  /** Why it matters and how to fix it. */
  description: string;
  sc: string[];
  impact: A11yImpact;
  category: RuleCategory;
  bestPractice?: boolean;
  dynamic?: DynamicKind;
  /** Documentation link (default: W3C Understanding page of the first criterion). */
  url?: string;
}

const ARIA = 'https://www.w3.org/TR/wai-aria-1.2/';

const R: RuleMeta[] = [
  // ------------------------------------------------------------ text alternatives
  { id: 'text-alt.img', category: 'text-alternatives', sc: ['1.1.1'], impact: 'critical',
    help: 'Every informative image has a text alternative; decorative images have alt=""',
    description: 'Screen reader users hear nothing useful for an image without a text alternative (often only its file name). Give <img> an alt that says what the image conveys, or alt="" when it is decoration.' },
  { id: 'text-alt.area', category: 'text-alternatives', sc: ['1.1.1', '2.4.4'], impact: 'critical',
    help: 'Every linked area of an image map has a text alternative',
    description: 'An <area href> is a link; without alt (or aria-label) it has no name, so its destination cannot be announced.' },
  { id: 'text-alt.input-image', category: 'text-alternatives', sc: ['1.1.1', '4.1.2'], impact: 'critical',
    help: 'Image buttons (<input type="image">) say what they do',
    description: 'An image button without alt is announced as a generic "Submit" at best. Give it an alt naming its action.' },
  { id: 'text-alt.role-img', category: 'text-alternatives', sc: ['1.1.1'], impact: 'serious',
    help: 'Elements exposed as images (role="img", <svg role="img">) have an accessible name',
    description: 'role="img" tells assistive technology to treat the element as one picture and to ignore its content, so the name must come from aria-label, aria-labelledby or an SVG <title>.' },
  { id: 'text-alt.object', category: 'text-alternatives', sc: ['1.1.1'], impact: 'serious',
    help: 'Embedded objects have a text alternative',
    description: 'An <object> needs a name (aria-label, aria-labelledby, title) or fallback content that describes it.' },

  // ------------------------------------------------------------ names and labels
  { id: 'name.button', category: 'names-and-labels', sc: ['4.1.2'], impact: 'critical',
    help: 'Buttons have an accessible name',
    description: 'A button without text, aria-label or aria-labelledby is announced as just "button". Icon-only buttons need an aria-label (or visually hidden text).' },
  { id: 'name.link', category: 'names-and-labels', sc: ['2.4.4', '4.1.2'], impact: 'serious',
    help: 'Links have an accessible name',
    description: 'A link with no text (for example an icon or an image without alt) cannot tell users where it goes.' },
  { id: 'name.form-field', category: 'names-and-labels', sc: ['4.1.2', '3.3.2'], impact: 'critical',
    help: 'Form fields have a label',
    description: 'Associate a <label> (for/id or wrapping), or use aria-labelledby / aria-label, so the purpose of the field is announced.' },
  { id: 'name.widget', category: 'names-and-labels', sc: ['4.1.2'], impact: 'serious',
    help: 'Widgets whose role requires a name have one',
    description: 'WAI-ARIA 1.2 requires a name for roles such as dialog, tab, menuitem, treeitem, option, meter and progressbar.' },
  { id: 'name.container', category: 'names-and-labels', sc: ['4.1.2'], impact: 'moderate', bestPractice: true,
    help: 'Composite widgets and regions whose role requires a name have one',
    description: 'Grids, trees, radio groups, tab panels and regions are easier to navigate when their name says what they hold.', url: `${ARIA}#namecomputation` },
  { id: 'name.frame', category: 'names-and-labels', sc: ['4.1.2'], impact: 'serious',
    help: 'Frames have a title or another accessible name',
    description: 'Users who list or move between frames hear the frame name; give every <iframe>/<frame> a title describing its content.' },
  { id: 'name.label-in-name', category: 'names-and-labels', sc: ['2.5.3'], impact: 'serious',
    help: 'The accessible name of a control contains its visible label',
    description: 'Speech-input users say what they see. When aria-label or aria-labelledby replaces the visible text, include that text (preferably at the start).' },
  { id: 'label.visible', category: 'forms', sc: ['3.3.2'], impact: 'moderate',
    help: 'Form fields have a visible label, not only a placeholder or tooltip',
    description: 'Placeholders disappear while typing and tooltips need a mouse; a persistent visible label helps everyone.' },
  { id: 'label.for-target', category: 'forms', sc: ['1.3.1'], impact: 'moderate', bestPractice: true,
    help: 'label[for] points to an existing form control',
    description: 'A label whose "for" names no element, or a non-labelable one, labels nothing.', url: 'https://html.spec.whatwg.org/multipage/forms.html#attr-label-for' },

  // ------------------------------------------------------------ ARIA
  { id: 'aria.role-valid', category: 'aria', sc: ['4.1.2'], impact: 'critical',
    help: 'role attributes hold at least one valid, non-abstract WAI-ARIA role',
    description: 'An unknown or abstract role (such as "widget" or "landmark") is ignored or misread by assistive technology.', url: `${ARIA}#role_definitions` },
  { id: 'aria.attr-name', category: 'aria', sc: ['4.1.2'], impact: 'critical',
    help: 'aria-* attributes are defined by WAI-ARIA',
    description: 'A misspelled aria-* attribute has no effect, so the state or property it was meant to convey is lost.', url: `${ARIA}#state_prop_def` },
  { id: 'aria.attr-value', category: 'aria', sc: ['4.1.2'], impact: 'critical',
    help: 'aria-* attributes have values of their type (true/false, token, number, ID reference)',
    description: 'Values outside the allowed set are treated as the default, so the conveyed state differs from what is shown.', url: `${ARIA}#propcharacteristic_value` },
  { id: 'aria.attr-required', category: 'aria', sc: ['4.1.2'], impact: 'critical',
    help: 'Elements with a role have the states and properties that role requires',
    description: 'For example role="checkbox" needs aria-checked, role="slider" needs aria-valuenow, role="combobox" needs aria-expanded.', url: `${ARIA}#requiredState` },
  { id: 'aria.attr-allowed', category: 'aria', sc: ['4.1.2'], impact: 'serious',
    help: 'aria-* attributes are supported by the role of the element',
    description: 'An attribute the role does not support (such as aria-checked on a button) is ignored or confuses assistive technology.', url: `${ARIA}#supportedState` },
  { id: 'aria.attr-prohibited', category: 'aria', sc: ['4.1.2'], impact: 'serious',
    help: 'Elements whose role prohibits naming have no aria-label or aria-labelledby',
    description: 'Generic containers (div, span), paragraphs and similar roles cannot be named; the label is dropped by many screen readers. Put the text in the content or use a role that can be named.', url: `${ARIA}#prohibitedattributes` },
  { id: 'aria.reference', category: 'aria', sc: ['4.1.2', '1.3.1'], impact: 'serious',
    help: 'ARIA ID references point to elements that exist',
    description: 'aria-labelledby, aria-describedby, aria-activedescendant and aria-errormessage must name existing IDs in the same document or shadow root.', url: `${ARIA}#valuetype_idref` },
  { id: 'aria.parent', category: 'aria', sc: ['1.3.1'], impact: 'critical',
    help: 'Roles that need a particular parent are inside it',
    description: 'For example a tab belongs in a tablist, an option in a listbox, a row in a table or grid. Outside its context the role is meaningless.', url: `${ARIA}#scope` },
  { id: 'aria.children', category: 'aria', sc: ['1.3.1'], impact: 'critical',
    help: 'Roles that need particular children own them',
    description: 'For example a list owns listitems, a tablist owns tabs, a listbox owns options. Other owned roles break the structure.', url: `${ARIA}#mustContain` },
  { id: 'aria.hidden-focusable', category: 'aria', sc: ['4.1.2'], impact: 'serious',
    help: 'Content hidden with aria-hidden="true" cannot receive keyboard focus',
    description: 'Keyboard users can tab into it but screen readers announce nothing. Make it inert, remove it from the tab order, or stop hiding it.' },
  { id: 'aria.hidden-body', category: 'aria', sc: ['4.1.2'], impact: 'critical',
    help: 'aria-hidden="true" is not set on the document body or root',
    description: 'It hides the entire page from assistive technology.' },
  { id: 'aria.nested-interactive', category: 'aria', sc: ['4.1.2'], impact: 'serious',
    help: 'Controls whose children are presentational contain no focusable elements',
    description: 'Buttons, checkboxes, tabs, options and similar roles flatten their content; a link or button inside one is unreachable for screen reader users.', url: `${ARIA}#childrenArePresentational` },
  { id: 'aria.role-allowed', category: 'aria', sc: ['4.1.2'], impact: 'moderate', bestPractice: true,
    help: 'Explicit roles are ones ARIA in HTML allows on that element',
    description: 'Giving an element a role that contradicts its native semantics (role="heading" on a <button>, any role on <label>) leaves the element behaving one way and announced another. Use the element that matches the role.', url: 'https://www.w3.org/TR/html-aria/#docconformance' },
  { id: 'aria.presentation-conflict', category: 'aria', sc: ['4.1.2'], impact: 'minor', bestPractice: true,
    help: 'role="none"/"presentation" is not used on focusable elements or elements with global ARIA attributes',
    description: 'Browsers ignore the presentational role in those cases (WAI-ARIA 1.2 §9.1), so the element keeps its native role.', url: `${ARIA}#conflict_resolution_presentation_none` },
  { id: 'aria.deprecated', category: 'aria', sc: ['4.1.2'], impact: 'minor', bestPractice: true,
    help: 'Deprecated WAI-ARIA roles and attributes are not used',
    description: 'role="directory", aria-grabbed and aria-dropeffect are deprecated in WAI-ARIA 1.2 and poorly supported.', url: ARIA },

  // ------------------------------------------------------------ colour
  { id: 'contrast.text', category: 'color', sc: ['1.4.3'], impact: 'serious',
    help: 'Text contrasts with its background at least 4.5:1 (3:1 for large text)',
    description: 'Large text is at least 24px, or 18.66px bold. Text over images or gradients is reported for review because its background varies.' },
  { id: 'contrast.text-enhanced', category: 'color', sc: ['1.4.6'], impact: 'serious',
    help: 'Text contrasts with its background at least 7:1 (4.5:1 for large text)',
    description: 'The enhanced (AAA) contrast level.' },
  { id: 'contrast.ui-component', category: 'color', sc: ['1.4.11'], impact: 'serious',
    help: 'The boundary of form fields contrasts at least 3:1 with what surrounds it',
    description: 'When a field is not filled with a contrasting colour, its border is what shows where it is; a faint border makes it invisible to people with low vision.' },
  { id: 'contrast.link-in-text', category: 'color', sc: ['1.4.1'], impact: 'serious',
    help: 'Links inside text are distinguishable by more than colour alone',
    description: 'Underline links in running text, or give them at least 3:1 contrast with the surrounding text (plus a non-colour cue on hover and focus).' },

  // ------------------------------------------------------------ document and language
  { id: 'page.title', category: 'structure', sc: ['2.4.2'], impact: 'serious',
    help: 'The document has a non-empty <title>',
    description: 'The title is the first thing announced and identifies the page among tabs and history entries.' },
  { id: 'lang.page', category: 'language', sc: ['3.1.1'], impact: 'serious',
    help: 'The <html> element has a lang attribute',
    description: 'Without it, screen readers pronounce the page in the user\'s default language.' },
  { id: 'lang.valid', category: 'language', sc: ['3.1.1', '3.1.2'], impact: 'serious',
    help: 'lang attributes hold well-formed BCP 47 language tags',
    description: 'A malformed tag (such as "english" or "en_US") is ignored, so the right pronunciation rules are not applied.' },

  // ------------------------------------------------------------ headings and landmarks
  { id: 'heading.order', category: 'structure', sc: ['1.3.1'], impact: 'moderate', bestPractice: true,
    help: 'Heading levels increase by one at a time',
    description: 'Skipping levels (h2 followed by h4) suggests missing sections to people who navigate by headings.' },
  { id: 'heading.empty', category: 'structure', sc: ['2.4.6'], impact: 'moderate', bestPractice: true,
    help: 'Headings have text',
    description: 'An empty heading is announced as a heading with no name and breaks heading navigation.' },
  { id: 'heading.level-one', category: 'structure', sc: ['1.3.1'], impact: 'moderate', bestPractice: true,
    help: 'The page has a level-one heading',
    description: 'A top-level heading lets users jump straight to the main content.' },
  { id: 'landmark.main', category: 'structure', sc: ['1.3.1'], impact: 'moderate', bestPractice: true,
    help: 'The page has a main landmark',
    description: 'A <main> element (or role="main") lets keyboard and screen reader users skip to the primary content.', url: `${ARIA}#main` },
  { id: 'landmark.single', category: 'structure', sc: ['1.3.1'], impact: 'moderate', bestPractice: true,
    help: 'The page has at most one main, banner and contentinfo landmark',
    description: 'Several of these page-level landmarks make it unclear which is the real one.' },
  { id: 'landmark.top-level', category: 'structure', sc: ['1.3.1'], impact: 'moderate', bestPractice: true,
    help: 'main, banner and contentinfo landmarks are not nested in other landmarks',
    description: 'These landmarks describe the page as a whole; nesting them hides that.' },
  { id: 'landmark.unique', category: 'structure', sc: ['1.3.1'], impact: 'moderate', bestPractice: true,
    help: 'Landmarks of the same kind have different names',
    description: 'Two navigation regions both announced as "navigation" cannot be told apart; give each an aria-label.' },
  { id: 'landmark.contained', category: 'structure', sc: ['1.3.1'], impact: 'moderate', bestPractice: true,
    help: 'All visible content is inside a landmark',
    description: 'Content outside landmarks is missed by people who move around the page by landmark.' },
  { id: 'bypass.blocks', category: 'navigation', sc: ['2.4.1'], impact: 'serious',
    help: 'The page offers a way to skip repeated blocks (a main landmark, headings or a skip link)',
    description: 'Keyboard users otherwise tab through every navigation link on every page.' },
  { id: 'bypass.skip-link', category: 'navigation', sc: ['2.4.1'], impact: 'moderate',
    help: 'Skip links point to an element on the page',
    description: 'A "skip to content" link whose target is missing moves focus nowhere.' },

  // ------------------------------------------------------------ ids
  { id: 'id.duplicate-referenced', category: 'ids', sc: ['4.1.2', '1.3.1'], impact: 'serious',
    help: 'IDs used by labels and ARIA references are unique',
    description: 'With duplicates, label[for], aria-labelledby and similar references pick the first match, which is often the wrong element.' },
  { id: 'id.duplicate', category: 'ids', sc: ['4.1.2'], impact: 'minor', bestPractice: true,
    help: 'id attributes are unique in their document or shadow root',
    description: 'Duplicate IDs break in-page links and any reference added later.' },

  // ------------------------------------------------------------ tables
  { id: 'table.headers-attr', category: 'tables', sc: ['1.3.1'], impact: 'serious',
    help: 'The headers attribute of a cell names header cells of the same table',
    description: 'Cells that point to missing IDs, to themselves, or to cells of another table lose their header association.' },
  { id: 'table.scope', category: 'tables', sc: ['1.3.1'], impact: 'moderate', bestPractice: true,
    help: 'scope is used on <th> only, with row, col, rowgroup or colgroup',
    description: 'Any other use is ignored, so the header relationship it was meant to set is lost.' },
  { id: 'table.has-headers', category: 'tables', sc: ['1.3.1'], impact: 'serious',
    help: 'Data tables mark their header cells',
    description: 'A grid of data without <th> (or columnheader/rowheader roles) is read cell by cell with no context. Layout tables should have role="presentation".' },
  { id: 'table.header-empty', category: 'tables', sc: ['1.3.1'], impact: 'minor', bestPractice: true,
    help: 'Table header cells have text',
    description: 'An empty header gives the cells of its column or row no context.' },
  { id: 'table.caption', category: 'tables', sc: ['1.3.1'], impact: 'minor', bestPractice: true,
    help: 'Data tables have a caption or accessible name',
    description: 'A name lets users decide whether to read the table and tell several tables apart.' },

  // ------------------------------------------------------------ lists
  { id: 'list.structure', category: 'lists', sc: ['1.3.1'], impact: 'serious',
    help: '<ul> and <ol> contain only <li>, <script> and <template> children',
    description: 'Other children break the list: its size and the position of each item are announced wrongly.' },
  { id: 'list.item-context', category: 'lists', sc: ['1.3.1'], impact: 'serious',
    help: '<li> elements are inside a <ul>, <ol> or <menu> (or role="list")',
    description: 'A list item outside a list is not exposed as part of one.' },
  { id: 'list.definition', category: 'lists', sc: ['1.3.1'], impact: 'serious',
    help: 'Description lists contain only <dt>/<dd> groups, and <dt>/<dd> are inside a <dl>',
    description: 'Terms and descriptions are only related when the structure follows HTML.' },

  // ------------------------------------------------------------ keyboard and focus
  { id: 'focus.tabindex-positive', category: 'keyboard-and-focus', sc: ['2.4.3'], impact: 'serious', bestPractice: true,
    help: 'No element has a tabindex greater than 0',
    description: 'Positive tabindex values move elements ahead of everything else in the tab order, which rarely matches the reading order.' },
  { id: 'keyboard.scrollable', category: 'keyboard-and-focus', sc: ['2.1.1'], impact: 'moderate',
    help: 'Scrollable regions can be reached with the keyboard',
    description: 'A region that scrolls but contains nothing focusable needs tabindex="0" (and a name) so keyboard users can scroll it.' },
  { id: 'keyboard.frame-tabindex', category: 'keyboard-and-focus', sc: ['2.1.1'], impact: 'serious',
    help: 'Frames with focusable content are not removed from the tab order',
    description: 'tabindex="-1" on an <iframe> whose document has focusable elements makes them unreachable by keyboard.' },
  { id: 'keyboard.trap', category: 'keyboard-and-focus', sc: ['2.1.2'], impact: 'critical', dynamic: 'keyboard',
    help: 'Focus can move away from every component with Tab / Shift+Tab',
    description: 'Checked by pressing Tab through the page with the keyboard. Focus that cycles inside a component (other than a modal dialog) traps keyboard users.' },
  { id: 'focus.visible', category: 'keyboard-and-focus', sc: ['2.4.7'], impact: 'serious', dynamic: 'keyboard',
    help: 'Elements show a visible focus indicator when reached with the keyboard',
    description: 'Checked by tabbing through the page and comparing each element\'s rendering with and without focus. Do not remove the outline without a replacement.' },
  { id: 'focus.hidden-stop', category: 'keyboard-and-focus', sc: ['2.4.7', '2.4.3'], impact: 'serious', dynamic: 'keyboard',
    help: 'Every tab stop is visible when it has focus',
    description: 'Keyboard focus that lands on an invisible element leaves users lost. Remove hidden elements from the tab order (or make them inert).' },
  { id: 'focus.order', category: 'keyboard-and-focus', sc: ['2.4.3'], impact: 'moderate', dynamic: 'keyboard',
    help: 'The tab order follows the reading order',
    description: 'Reported for review when Tab moves focus backwards on the page (up and to the left of the previous stop).' },
  { id: 'focus.not-obscured', category: 'keyboard-and-focus', sc: ['2.4.11'], impact: 'serious', dynamic: 'keyboard',
    help: 'A focused element is not entirely hidden by other content',
    description: 'Sticky headers, footers and banners must not cover the element that has keyboard focus.' },

  // ------------------------------------------------------------ pointer, zoom, forms
  { id: 'target.size', category: 'layout', sc: ['2.5.8'], impact: 'serious',
    help: 'Pointer targets are at least 24 by 24 CSS pixels, or spaced so a 24px circle around each does not touch another',
    description: 'Small targets close together are hard to hit for people with tremors or on touch screens. Inline links in text and controls sized by the browser are exempt.' },
  { id: 'target.size-enhanced', category: 'layout', sc: ['2.5.5'], impact: 'moderate',
    help: 'Pointer targets are at least 44 by 44 CSS pixels',
    description: 'The enhanced (AAA) target size.' },
  { id: 'zoom.viewport', category: 'layout', sc: ['1.4.4'], impact: 'critical',
    help: 'The viewport meta tag does not disable zooming',
    description: 'user-scalable=no or a maximum-scale below 2 stops people with low vision from enlarging the page on mobile browsers.' },
  { id: 'timing.meta-refresh', category: 'timing-and-motion', sc: ['2.2.1'], impact: 'critical',
    help: 'The page does not refresh or redirect itself on a timer',
    description: '<meta http-equiv="refresh"> with a delay moves users away before they finish reading. Redirect on the server instead.' },
  { id: 'form.autocomplete', category: 'forms', sc: ['1.3.5'], impact: 'serious',
    help: 'autocomplete attributes use the tokens defined by HTML',
    description: 'Valid tokens (such as "email", "given-name", "shipping postal-code") let browsers fill fields and let assistive technology show their purpose.', url: 'https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill' },
  { id: 'frame.title-unique', category: 'names-and-labels', sc: ['4.1.2'], impact: 'minor', bestPractice: true,
    help: 'Frames showing different content have different titles',
    description: 'Identical titles make the frames indistinguishable in a frames list.' },

  // ------------------------------------------------------------ media and motion
  { id: 'media.captions', category: 'media', sc: ['1.2.2'], impact: 'critical',
    help: 'Videos with sound have captions',
    description: 'Reported for review: confirm that a captions track (<track kind="captions">) exists or the video has no audio.' },
  { id: 'media.audio-description', category: 'media', sc: ['1.2.5'], impact: 'moderate',
    help: 'Videos have an audio description of important visual information',
    description: 'Reported for review: confirm a descriptions track or a described version, unless the soundtrack already conveys everything.' },
  { id: 'media.audio-alternative', category: 'media', sc: ['1.2.1'], impact: 'serious',
    help: 'Audio-only content has a transcript',
    description: 'Reported for review: confirm a text transcript is provided near the audio.' },
  { id: 'media.autoplay', category: 'media', sc: ['1.4.2'], impact: 'moderate',
    help: 'Audio that plays automatically for more than 3 seconds can be paused or muted',
    description: 'Autoplaying sound drowns out the screen reader. Start muted, or show controls.' },
  { id: 'motion.blink', category: 'timing-and-motion', sc: ['2.2.2'], impact: 'serious',
    help: '<blink> is not used',
    description: 'Blinking text cannot be paused and distracts or harms some users.' },
  { id: 'motion.marquee', category: 'timing-and-motion', sc: ['2.2.2'], impact: 'serious',
    help: '<marquee> is not used',
    description: 'Moving text cannot be paused and is hard to read.' },

  // ------------------------------------------------------------ layout (some dynamic)
  { id: 'layout.orientation', category: 'layout', sc: ['1.3.4'], impact: 'serious',
    help: 'Content is not locked to portrait or landscape with CSS',
    description: 'Style rules under an orientation media query that rotate or hide the page lock users who cannot turn their device.' },
  { id: 'layout.reflow', category: 'layout', sc: ['1.4.10'], impact: 'serious', dynamic: 'reflow',
    help: 'At 320 CSS pixels wide, content reflows without horizontal scrolling',
    description: 'Checked by resizing the viewport to 320px. People who zoom to 400% see the page at that width. Tables, maps, diagrams and code may scroll.' },
  { id: 'text.spacing', category: 'layout', sc: ['1.4.12'], impact: 'serious', dynamic: 'textSpacing',
    help: 'No text is cut off when line, letter, word and paragraph spacing are increased',
    description: 'Checked by applying line-height 1.5, letter-spacing 0.12em, word-spacing 0.16em and 2em paragraph spacing. Fixed heights with overflow:hidden are the usual cause.' },
];

export const RULES: readonly RuleMeta[] = R;
export const RULES_BY_ID: ReadonlyMap<string, RuleMeta> = new Map(R.map((r) => [r.id, r]));

export function ruleUrl(r: RuleMeta): string {
  return r.url ?? understandingUrl(r.sc[0]);
}

/** WCAG level of a rule: the lowest level among its criteria (undefined for best practices). */
export function ruleLevel(r: RuleMeta): WcagLevel | undefined {
  if (r.bestPractice) return undefined;
  const levels = r.sc.map((sc) => criterion(sc).level);
  return levels.includes('A') ? 'A' : levels.includes('AA') ? 'AA' : 'AAA';
}

/** Tags: "wcag2a" / "wcag21aa" / "wcag22aa" level tags, "wcag22", per-criterion "wcag143" tags, "best-practice", the category and "dynamic". */
export function ruleTags(r: RuleMeta): string[] {
  const t = new Set<string>();
  if (r.bestPractice) t.add('best-practice');
  else {
    for (const sc of r.sc) t.add(levelTag(sc));
    t.add('wcag22');
  }
  for (const sc of r.sc) t.add(scTag(sc));
  t.add(`cat.${r.category}`);
  if (r.dynamic) t.add('dynamic');
  return [...t];
}

