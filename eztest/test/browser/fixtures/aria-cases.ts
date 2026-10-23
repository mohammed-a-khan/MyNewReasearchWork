/**
 * Role and accessible name/description conformance fixtures for EZTest's
 * page engine. Expected values are derived by hand from WAI-ARIA 1.2,
 * HTML-AAM and accname 1.2 (with the spec's own examples adapted), plus
 * real-world markup patterns (Material, Bootstrap, React-style widgets,
 * custom elements with shadow DOM, tables vs grids).
 *
 * Each case renders `html` (then runs `setup`, if any) and checks the element
 * matched by `sel` (CSS, default `#t`, pierces open shadow roots through
 * `host >>> inner` written as two steps: see `shadow`).
 *
 * - `role`: expected computed role; `null` = no role.
 * - `name`, `desc`: expected accessible name / description (normalised).
 * - `chromium`: a documented, expected difference with Chromium's own
 *   accessibility tree (CDP Accessibility.getPartialAXTree), with the reason.
 */
export interface AriaCase {
  id: string;
  html: string;
  sel?: string;
  /** CSS of a shadow host, then `sel` is looked up inside its open shadow root. */
  shadow?: string;
  setup?: string;
  role?: string | null;
  name?: string;
  desc?: string;
  level?: number;
  checked?: boolean | 'mixed';
  pressed?: boolean | 'mixed';
  expanded?: boolean;
  selected?: boolean;
  disabled?: boolean;
  chromium?: string;
}

const VH =
  '<style>.visually-hidden,.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}</style>';

export const ARIA_CASES: AriaCase[] = [
  // ------------------------------------------------ implicit roles: HTML-AAM
  { id: 'button', html: '<button id=t>Go</button>', role: 'button', name: 'Go' },
  { id: 'a-href', html: '<a id=t href="#x">Home</a>', role: 'link', name: 'Home' },
  { id: 'a-no-href', html: '<a id=t>Home</a>', role: 'generic', name: '' },
  { id: 'area-href', html: '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" usemap="#m" alt="map"><map name=m><area id=t href="#a" alt="North" shape=rect coords="0,0,1,1"></map>', role: 'link', name: 'North', chromium: 'Chromium exposes image-map areas through the img and reports the area node itself as ignored' },
  { id: 'input-default', html: '<input id=t>', role: 'textbox', name: '' },
  { id: 'input-text-list', html: '<input id=t list=l><datalist id=l><option value=a></datalist>', role: 'combobox' },
  { id: 'input-search', html: '<input id=t type=search>', role: 'searchbox' },
  { id: 'input-search-list', html: '<input id=t type=search list=l><datalist id=l></datalist>', role: 'combobox' },
  { id: 'input-email', html: '<input id=t type=email>', role: 'textbox' },
  { id: 'input-tel', html: '<input id=t type=tel>', role: 'textbox' },
  { id: 'input-url', html: '<input id=t type=url>', role: 'textbox' },
  { id: 'input-password', html: '<input id=t type=password>', role: 'textbox', chromium: 'HTML-AAM gives password no role; EZTest follows browsers (textbox) so getByRole("textbox") finds it' },
  { id: 'input-number', html: '<input id=t type=number>', role: 'spinbutton' },
  { id: 'input-range', html: '<input id=t type=range>', role: 'slider' },
  { id: 'input-checkbox', html: '<input id=t type=checkbox>', role: 'checkbox', checked: false },
  { id: 'input-checkbox-checked', html: '<input id=t type=checkbox checked>', role: 'checkbox', checked: true },
  { id: 'input-checkbox-indeterminate', html: '<input id=t type=checkbox>', setup: 't.indeterminate = true', role: 'checkbox', checked: 'mixed' },
  { id: 'input-checkbox-aria-checked-ignored', html: '<input id=t type=checkbox aria-checked=true>', role: 'checkbox', checked: false },
  { id: 'input-radio', html: '<input id=t type=radio checked>', role: 'radio', checked: true },
  { id: 'input-submit', html: '<input id=t type=submit>', role: 'button', name: 'Submit' },
  { id: 'input-reset', html: '<input id=t type=reset>', role: 'button', name: 'Reset' },
  { id: 'input-button-value', html: '<input id=t type=button value="Go now">', role: 'button', name: 'Go now' },
  { id: 'input-image-alt', html: '<input id=t type=image alt="Search" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">', role: 'button', name: 'Search' },
  { id: 'input-color', html: '<input id=t type=color>', role: null, chromium: 'HTML-AAM: no corresponding role; Chromium exposes an internal ColorWell role' },
  { id: 'input-date', html: '<input id=t type=date>', role: null, chromium: 'HTML-AAM: no corresponding role; Chromium exposes an internal Date role' },
  { id: 'input-file', html: '<input id=t type=file>', role: null, chromium: 'HTML-AAM: no corresponding role; Chromium exposes it as a button' },
  { id: 'textarea', html: '<textarea id=t>typed</textarea>', role: 'textbox', name: '' },
  { id: 'select', html: '<select id=t><option>One</option></select>', role: 'combobox' },
  { id: 'select-multiple', html: '<select id=t multiple><option>One</option></select>', role: 'listbox' },
  { id: 'select-size', html: '<select id=t size=3><option>One</option></select>', role: 'listbox' },
  { id: 'option', html: '<select size=2><option id=t selected>First choice</option><option>2</option></select>', role: 'option', name: 'First choice', selected: true },
  { id: 'option-label-attr', html: '<select size=2><option id=t label="Short">Long text</option></select>', role: 'option', name: 'Short' },
  { id: 'optgroup', html: '<select size=3><optgroup id=t label="Fruit"><option>Apple</option></optgroup></select>', role: 'group', name: 'Fruit' },
  { id: 'h1', html: '<h1 id=t>Orders</h1>', role: 'heading', name: 'Orders', level: 1 },
  { id: 'h4', html: '<h4 id=t>Sub</h4>', role: 'heading', level: 4 },
  { id: 'img-alt', html: '<img id=t alt="Company logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">', role: 'img', name: 'Company logo' },
  { id: 'img-empty-alt', html: '<img id=t alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">', role: 'presentation', name: '' },
  { id: 'img-empty-alt-aria-label', html: '<img id=t alt="" aria-label="Chart" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">', role: 'img', name: 'Chart' },
  { id: 'img-no-alt-title', html: '<img id=t title="Avatar" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">', role: 'img', name: 'Avatar' },
  { id: 'ul', html: '<ul id=t><li>a</li></ul>', role: 'list' },
  { id: 'ol', html: '<ol id=t><li>a</li></ol>', role: 'list' },
  { id: 'menu', html: '<menu id=t><li>a</li></menu>', role: 'list' },
  { id: 'li', html: '<ul><li id=t>Item</li></ul>', role: 'listitem' },
  { id: 'nav', html: '<nav id=t>x</nav>', role: 'navigation' },
  { id: 'main', html: '<main id=t>x</main>', role: 'main' },
  { id: 'article', html: '<article id=t>x</article>', role: 'article' },
  { id: 'aside', html: '<aside id=t>x</aside>', role: 'complementary' },
  { id: 'aside-in-article', html: '<article><aside id=t>x</aside></article>', role: 'generic', chromium: 'HTML-AAM: aside scoped to sectioning content without a name is generic' },
  { id: 'header-top', html: '<header id=t>x</header>', role: 'banner' },
  { id: 'footer-top', html: '<footer id=t>x</footer>', role: 'contentinfo' },
  { id: 'header-in-article', html: '<article><header id=t>x</header></article>', role: 'generic', chromium: 'Chromium 141 already uses the ARIA 1.3 draft role sectionheader; ARIA 1.2 / HTML-AAM say generic' },
  { id: 'footer-in-section', html: '<section><footer id=t>x</footer></section>', role: 'generic', chromium: 'Chromium 141 already uses the ARIA 1.3 draft role sectionfooter; ARIA 1.2 / HTML-AAM say generic' },
  { id: 'section-unnamed', html: '<section id=t>x</section>', role: 'generic' },
  { id: 'section-aria-label', html: '<section id=t aria-label="Billing">x</section>', role: 'region', name: 'Billing' },
  { id: 'section-labelledby', html: '<section id=t aria-labelledby=h><h2 id=h>Shipping</h2></section>', role: 'region', name: 'Shipping' },
  { id: 'form-unnamed', html: '<form id=t><input></form>', role: 'generic' },
  { id: 'form-named', html: '<form id=t aria-label="Sign in"><input></form>', role: 'form', name: 'Sign in' },
  { id: 'dialog', html: '<dialog id=t open aria-label="Confirm">x</dialog>', role: 'dialog', name: 'Confirm' },
  { id: 'details', html: '<details id=t><summary>More</summary>x</details>', role: 'group', expanded: false },
  { id: 'details-open', html: '<details id=t open><summary>More</summary>x</details>', role: 'group', expanded: true },
  { id: 'fieldset-legend', html: '<fieldset id=t><legend>Address</legend><input></fieldset>', role: 'group', name: 'Address' },
  { id: 'figure-figcaption', html: '<figure id=t><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><figcaption>Sales 2026</figcaption></figure>', role: 'figure', name: 'Sales 2026', chromium: 'HTML-AAM names figure from its figcaption; Chromium leaves the name empty' },
  { id: 'hr', html: '<hr id=t>', role: 'separator' },
  { id: 'progress', html: '<progress id=t value=3 max=10></progress>', role: 'progressbar' },
  { id: 'meter', html: '<meter id=t value=0.5></meter>', role: 'meter' },
  { id: 'output', html: '<output id=t>5</output>', role: 'status' },
  { id: 'p', html: '<p id=t>Para</p>', role: 'paragraph' },
  { id: 'blockquote', html: '<blockquote id=t>Q</blockquote>', role: 'blockquote' },
  { id: 'code', html: '<code id=t>x</code>', role: 'code' },
  { id: 'em', html: '<em id=t>x</em>', role: 'emphasis' },
  { id: 'strong', html: '<strong id=t>x</strong>', role: 'strong' },
  { id: 'del', html: '<del id=t>x</del>', role: 'deletion' },
  { id: 'ins', html: '<ins id=t>x</ins>', role: 'insertion' },
  { id: 'mark', html: '<mark id=t>x</mark>', role: 'mark' },
  { id: 'sub', html: '<sub id=t>x</sub>', role: 'subscript' },
  { id: 'sup', html: '<sup id=t>x</sup>', role: 'superscript' },
  { id: 'time', html: '<time id=t>noon</time>', role: 'time' },
  { id: 'dfn', html: '<dfn id=t>x</dfn>', role: 'term' },
  { id: 'dd', html: '<dl><dt>T</dt><dd id=t>D</dd></dl>', role: 'definition' },
  { id: 'dt', html: '<dl><dt id=t>T</dt><dd>D</dd></dl>', role: 'term' },
  { id: 'search', html: '<search id=t>x</search>', role: 'search' },
  { id: 'address', html: '<address id=t>x</address>', role: 'group' },
  { id: 'div', html: '<div id=t>x</div>', role: 'generic' },
  { id: 'span', html: '<span id=t>x</span>', role: 'generic' },
  { id: 'svg', html: '<svg id=t width=10 height=10><title>Pie chart</title><circle r=4 cx=5 cy=5></circle></svg>', role: 'img', name: 'Pie chart', chromium: 'HTML-AAM maps svg to graphics-document; EZTest reports img (what testers query)' },
  { id: 'datalist', html: '<datalist id=t><option value=a></datalist>', role: 'listbox', chromium: 'datalist is not rendered, so Chromium marks it ignored; the role per HTML-AAM is still listbox' },
  { id: 'summary', html: '<details><summary id=t>More</summary></details>', role: null, chromium: 'HTML-AAM: no corresponding role; Chromium exposes DisclosureTriangle' },
  { id: 'label-element', html: '<label id=t>Name <input></label>', role: null },

  // ------------------------------------------------ tables vs grids
  { id: 'table', html: '<table id=t><tr><td>1</td></tr></table>', role: 'table', chromium: 'Chromium heuristically treats a one-cell table without headers as a layout table (LayoutTable*); HTML-AAM maps it to table semantics' },
  { id: 'tr', html: '<table><tr id=t><td>1</td></tr></table>', role: 'row', chromium: 'Chromium heuristically treats a one-cell table without headers as a layout table (LayoutTable*); HTML-AAM maps it to table semantics' },
  { id: 'td', html: '<table><tr><td id=t>1</td></tr></table>', role: 'cell', name: '1', chromium: 'Chromium heuristically treats a one-cell table without headers as a layout table (LayoutTable*); HTML-AAM maps it to table semantics' },
  { id: 'th-col', html: '<table><thead><tr><th id=t>Qty</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>', role: 'columnheader', name: 'Qty' },
  { id: 'th-scope-row', html: '<table><tr><th id=t scope=row>Total</th><td>9</td></tr></table>', role: 'rowheader', name: 'Total' },
  { id: 'th-implicit-row', html: '<table><tr><th>A</th><th>B</th></tr><tr><th id=t>Row 1</th><td>9</td></tr></table>', role: 'rowheader' },
  { id: 'th-all-headers', html: '<table><tr><th id=t>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>', role: 'columnheader' },
  { id: 'thead', html: '<table><thead id=t><tr><th>A</th></tr></thead></table>', role: 'rowgroup' },
  { id: 'tbody', html: '<table><tbody id=t><tr><td>A</td></tr></tbody></table>', role: 'rowgroup', chromium: 'Chromium heuristically treats a one-cell table without headers as a layout table (LayoutTable*); HTML-AAM maps it to table semantics' },
  { id: 'grid-td', html: '<table role=grid><tr><td id=t>1</td></tr></table>', role: 'gridcell' },
  { id: 'treegrid-td', html: '<table role=treegrid><tr><td id=t>1</td></tr></table>', role: 'gridcell' },
  { id: 'grid-th', html: '<table role=grid><thead><tr><th id=t>Name</th></tr></thead></table>', role: 'columnheader', name: 'Name' },
  { id: 'grid-selected-cell', html: '<table role=grid><tr><td id=t aria-selected=true>1</td></tr></table>', role: 'gridcell', selected: true },
  { id: 'presentation-table-td', html: '<table role=presentation><tr><td id=t>1</td></tr></table>', role: null, chromium: 'WAI-ARIA 1.2 9.1: required owned elements of a presentational table inherit none; Chromium reports them as generic' },
  { id: 'presentation-table-tr', html: '<table role=presentation><tr id=t><td>1</td></tr></table>', role: null, chromium: 'WAI-ARIA 1.2 9.1: required owned elements of a presentational table inherit none; Chromium reports them as generic' },
  { id: 'aria-grid-div', html: '<div role=grid><div role=row><div role=gridcell id=t>Cell A</div></div></div>', role: 'gridcell', name: 'Cell A' },
  { id: 'table-caption', html: '<table id=t><caption>Invoices</caption><tr><td>1</td></tr></table>', role: 'table', name: 'Invoices' },
  { id: 'row-name', html: '<table><tr id=t><td>Ann</td><td>42</td></tr></table>', role: 'row', name: 'Ann 42', chromium: 'Chromium heuristically treats a one-cell table without headers as a layout table (LayoutTable*); HTML-AAM maps it to table semantics' },

  // ------------------------------------------------ explicit roles and conflicts
  { id: 'role-button-div', html: '<div id=t role=button tabindex=0>Save draft</div>', role: 'button', name: 'Save draft' },
  { id: 'role-fallback-token', html: '<div id=t role="fancy button">x</div>', role: 'button' },
  { id: 'role-invalid', html: '<div id=t role="fancy">x</div>', role: 'generic' },
  { id: 'role-case-insensitive', html: '<div id=t role="BUTTON">x</div>', role: 'button' },
  { id: 'role-abstract-ignored', html: '<div id=t role="widget">x</div>', role: 'generic' },
  { id: 'role-none-heading', html: '<h1 id=t role=none>Title</h1>', role: 'none', name: '' },
  { id: 'role-presentation-focusable-button', html: '<button id=t role=presentation>OK</button>', role: 'button', name: 'OK' },
  { id: 'role-none-global-aria', html: '<h2 id=t role=none aria-label="Kept">T</h2>', role: 'heading', name: 'Kept' },
  { id: 'role-none-tabindex', html: '<span id=t role=none tabindex=0>T</span>', role: 'generic' },
  { id: 'role-none-list-li', html: '<ul role=none><li id=t>a</li></ul>', role: 'none' },
  { id: 'role-heading-level', html: '<div id=t role=heading aria-level=3>H</div>', role: 'heading', level: 3, name: 'H' },
  { id: 'role-heading-default-level', html: '<div id=t role=heading>H</div>', role: 'heading', level: 2 },
  { id: 'h1-aria-level', html: '<h1 id=t aria-level=5>H</h1>', role: 'heading', level: 5 },
  { id: 'role-switch', html: '<div id=t role=switch aria-checked=true tabindex=0>Wi-Fi</div>', role: 'switch', checked: true, name: 'Wi-Fi' },
  { id: 'role-checkbox-mixed', html: '<div id=t role=checkbox aria-checked=mixed tabindex=0>All</div>', role: 'checkbox', checked: 'mixed' },
  { id: 'role-checkbox-default', html: '<div id=t role=checkbox tabindex=0>Opt</div>', role: 'checkbox', checked: false },
  { id: 'role-img-synonym', html: '<div id=t role=image aria-label="Pic"></div>', role: 'img', name: 'Pic' },
  { id: 'a-role-button', html: '<a id=t role=button>Open</a>', role: 'button', name: 'Open' },
  { id: 'role-tab-selected', html: '<div role=tablist><button id=t role=tab aria-selected=true>Home</button></div>', role: 'tab', selected: true, name: 'Home' },
  { id: 'role-menuitemcheckbox', html: '<div role=menu><div id=t role=menuitemcheckbox aria-checked=true>Bold</div></div>', role: 'menuitemcheckbox', checked: true, name: 'Bold' },
  { id: 'role-treeitem-level', html: '<div role=tree><div id=t role=treeitem aria-level=2 aria-expanded=true>Docs</div></div>', role: 'treeitem', level: 2, expanded: true },

  // ------------------------------------------------ disabled
  { id: 'disabled-button', html: '<button id=t disabled>X</button>', disabled: true },
  { id: 'disabled-fieldset', html: '<fieldset disabled><input id=t></fieldset>', disabled: true },
  { id: 'disabled-fieldset-legend-exempt', html: '<fieldset disabled><legend><input id=t></legend></fieldset>', disabled: false },
  { id: 'disabled-aria', html: '<div id=t role=button aria-disabled=true>X</div>', disabled: true },
  { id: 'disabled-aria-ancestor', html: '<div aria-disabled=true><button id=t>X</button></div>', disabled: true },
  { id: 'disabled-optgroup-option', html: '<select><optgroup disabled label=g><option id=t>o</option></optgroup></select>', disabled: true },
  { id: 'enabled-plain', html: '<button id=t>X</button>', disabled: false },

  // ------------------------------------------------ accname: aria-labelledby
  { id: 'lb-single', html: '<span id=l>Billing name</span><input id=t aria-labelledby=l>', name: 'Billing name' },
  { id: 'lb-multiple', html: '<span id=a>Delete</span><span id=b>file.pdf</span><button id=t aria-labelledby="a b">x</button>', name: 'Delete file.pdf' },
  { id: 'lb-self', html: '<button id=t aria-labelledby="t f">Delete</button><span id=f>Documentation.pdf</span>', name: 'Delete Documentation.pdf' },
  { id: 'lb-hidden-ref', html: '<span id=l hidden>Secret label</span><button id=t aria-labelledby=l>x</button>', name: 'Secret label' },
  { id: 'lb-ref-aria-label', html: '<span id=l aria-label="From aria-label">content</span><button id=t aria-labelledby=l>x</button>', name: 'From aria-label' },
  { id: 'lb-not-recursive', html: '<span id=a aria-labelledby=b>A text</span><span id=b>B text</span><button id=t aria-labelledby=a>x</button>', name: 'A text' },
  { id: 'lb-missing-id', html: '<button id=t aria-labelledby="nope">Fallback</button>', name: 'Fallback' },
  { id: 'lb-beats-aria-label', html: '<span id=l>Labelled</span><button id=t aria-labelledby=l aria-label="Aria">x</button>', name: 'Labelled' },
  { id: 'lb-hidden-descendant-skipped', html: '<div id=l>Visible <span style="display:none">gone</span>part</div><button id=t aria-labelledby=l>x</button>', name: 'Visible part' },
  { id: 'lb-embedded-textbox', html: '<span id=a>Flash the screen</span><input id=b value=3 aria-label="times count"><span id=c>times</span><div id=t role=checkbox tabindex=0 aria-labelledby="a b c"></div>', name: 'Flash the screen 3 times' },
  { id: 'lb-spec-shutdown', html: '<div id=t role=checkbox tabindex=0 aria-labelledby="ls lt lu"></div><span id=ls>Shut down computer after</span><input id=lt type=text value=10><span id=lu>minutes</span>', name: 'Shut down computer after 10 minutes' },

  // ------------------------------------------------ accname: aria-label
  { id: 'aria-label-beats-content', html: '<button id=t aria-label="Close dialog">X</button>', name: 'Close dialog' },
  { id: 'aria-label-whitespace-ignored', html: '<button id=t aria-label="   ">Content</button>', name: 'Content' },
  { id: 'aria-label-generic', html: '<div id=t aria-label="Panel">x</div>', role: 'generic', name: 'Panel' },

  // ------------------------------------------------ accname: native labels
  { id: 'label-for', html: '<label for=t>First name</label><input id=t>', name: 'First name' },
  { id: 'label-wrap', html: '<label>Last name <input id=t></label>', name: 'Last name' },
  { id: 'label-multiple', html: '<label for=t>Phone</label><input id=t><label for=t>(mobile)</label>', name: 'Phone (mobile)' },
  { id: 'label-hidden-span', html: '<label for=t>Email<span hidden> (secret)</span></label><input id=t>', name: 'Email' },
  { id: 'label-embedded-number', html: '<label><input id=t type=checkbox> Flash the screen <input type=number value=5 aria-label=n> times</label>', name: 'Flash the screen 5 times' },
  { id: 'label-embedded-select', html: '<label><input id=t type=checkbox> Repeat every <select aria-label=s><option>day</option><option selected>week</option></select></label>', name: 'Repeat every week' },
  { id: 'label-embedded-range', html: '<label><input id=t type=checkbox> Volume <span role=slider tabindex=0 aria-valuenow=7 aria-valuetext="seven of ten"></span></label>', name: 'Volume seven of ten' },
  { id: 'label-embedded-aria-valuenow', html: '<label><input id=t type=checkbox> Level <span role=spinbutton tabindex=0 aria-valuenow=4></span></label>', name: 'Level 4' },
  { id: 'label-select', html: '<label for=t>Country</label><select id=t><option>NL</option></select>', name: 'Country' },
  { id: 'label-textarea', html: '<label for=t>Notes</label><textarea id=t>body</textarea>', name: 'Notes' },
  { id: 'label-meter', html: '<label for=t>Disk</label><meter id=t value=0.4></meter>', name: 'Disk' },
  { id: 'label-css-before', html: '<style>#lab::before{content:"* "}</style><label id=lab for=t>Required</label><input id=t>', name: '* Required' },
  { id: 'input-title', html: '<input id=t title="Search the site">', name: 'Search the site' },
  { id: 'input-placeholder', html: '<input id=t placeholder="you@example.com">', name: 'you@example.com' },
  { id: 'input-title-before-placeholder', html: '<input id=t title="Title wins" placeholder="Placeholder">', name: 'Title wins' },
  { id: 'input-label-beats-title', html: '<label for=t>Label</label><input id=t title="Tooltip">', name: 'Label', desc: 'Tooltip' },
  { id: 'input-submit-value', html: '<input id=t type=submit value="Place order">', name: 'Place order' },
  { id: 'input-image-no-alt', html: '<input id=t type=image src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">', name: 'Submit', chromium: 'HTML-AAM fallback string; Chromium uses a localized "Submit"' },
  { id: 'textarea-content-not-name', html: '<textarea id=t>hello</textarea>', name: '' },
  { id: 'aria-placeholder', html: '<div id=t role=textbox contenteditable aria-placeholder="Write a reply"></div>', name: 'Write a reply' },

  // ------------------------------------------------ accname: name from content
  { id: 'content-img-alt', html: '<button id=t><img alt="Print" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button>', name: 'Print' },
  { id: 'content-aria-hidden-icon', html: '<button id=t><span aria-hidden=true>★</span> Favourite</button>', name: 'Favourite' },
  { id: 'content-display-none', html: '<button id=t>Save<span style="display:none"> hidden</span></button>', name: 'Save' },
  { id: 'content-visibility-hidden', html: '<button id=t>Save<span style="visibility:hidden"> hidden</span></button>', name: 'Save' },
  { id: 'content-visible-in-hidden', html: '<button id=t><span style="visibility:hidden">no <span style="visibility:visible">yes</span></span></button>', name: 'yes', chromium: 'accname 1.2 hides per node: a visibility:visible child of a visibility:hidden parent is not hidden; Chromium drops the whole subtree' },
  { id: 'content-before-after', html: '<style>#t::before{content:"Step "} #t::after{content:" of 3"}</style><button id=t>1</button>', name: 'Step 1 of 3' },
  { id: 'content-css-alt', html: '<style>#t::before{content:"\\2605" / "Starred "}</style><button id=t>Item</button>', name: 'Starred Item' },
  { id: 'content-css-attr', html: '<style>#t::after{content:attr(data-suffix)}</style><a id=t href="#" data-suffix=" (opens in new tab)">Docs</a>', name: 'Docs (opens in new tab)' },
  { id: 'content-inline-concat', html: '<a id=t href="#">Foo<b>bar</b></a>', name: 'Foobar' },
  { id: 'content-block-spacing', html: '<div id=t role=link tabindex=0><div>Foo</div><div>Bar</div></div>', name: 'Foo Bar' },
  { id: 'content-br', html: '<button id=t>Line<br>two</button>', name: 'Line two' },
  { id: 'content-presentation-child', html: '<button id=t><span role=presentation>Inner</span> text</button>', name: 'Inner text' },
  { id: 'content-nested-link', html: '<h2 id=t><a href="#">Read</a> more</h2>', name: 'Read more' },
  { id: 'content-title-fallback', html: '<button id=t title="Close"></button>', name: 'Close', desc: '' },
  { id: 'content-child-title', html: '<button id=t><span title="Edit"></span></button>', name: 'Edit', chromium: 'accname 1.2 step 2I applies to every node in the recursion (a child\'s title); Chromium only uses the root\'s title' },
  { id: 'content-link-img', html: '<a id=t href="/"><img alt="Home" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>', name: 'Home' },
  { id: 'content-embedded-textbox-in-button', html: '<div id=t role=button tabindex=0>Qty <input value=2 aria-label=q></div>', name: 'Qty 2' },
  { id: 'content-whitespace', html: '<button id=t>\n   Many\n\n   spaces  </button>', name: 'Many spaces' },
  { id: 'content-nbsp', html: '<button id=t>A&nbsp;&nbsp;B</button>', name: 'A B', chromium: 'The engine normalises NBSP to a space (contract TextMatch rule); Chromium keeps NBSP characters in names' },
  { id: 'content-not-for-list', html: '<ul id=t><li>a</li></ul>', name: '' },
  { id: 'content-not-for-navigation', html: '<nav id=t>Links</nav>', name: '' },
  { id: 'content-option-in-listbox', html: '<div role=listbox><div id=t role=option aria-selected=true>Red</div></div>', name: 'Red', selected: true },
  { id: 'content-cell', html: '<table><tr><td id=t>  <b>4</b> items </td></tr></table>', name: '4 items' },
  { id: 'content-heading-with-hidden', html: '<h1 id=t>Inbox <span class="badge" aria-hidden=true>3</span></h1>', name: 'Inbox' },
  { id: 'content-svg-title-child', html: '<button id=t><svg width=8 height=8><title>Remove</title></svg></button>', name: 'Remove' },
  { id: 'content-svg-aria-hidden', html: '<button id=t><svg aria-hidden=true width=8 height=8><title>X</title></svg>Remove</button>', name: 'Remove' },
  { id: 'hidden-root-name', html: '<button id=t style="display:none">Ghost</button>', name: 'Ghost' },
  { id: 'aria-owns-content', html: '<div id=t role=button tabindex=0 aria-owns=o>Open</div><span id=o>menu</span>', name: 'Open menu' },

  // ------------------------------------------------ accname: descriptions
  { id: 'desc-describedby', html: '<button id=t aria-describedby=d>Pay</button><p id=d>Charges your card</p>', name: 'Pay', desc: 'Charges your card' },
  { id: 'desc-describedby-multi', html: '<input id=t aria-label=Pw aria-describedby="d1 d2"><span id=d1>8+ chars</span><span id=d2>one digit</span>', desc: '8+ chars one digit' },
  { id: 'desc-describedby-hidden', html: '<button id=t aria-describedby=d>Pay</button><p id=d hidden>Hidden help</p>', desc: 'Hidden help' },
  { id: 'desc-aria-description', html: '<button id=t aria-description="Deletes forever">Delete</button>', desc: 'Deletes forever' },
  { id: 'desc-title', html: '<button id=t title="Keyboard: Ctrl+S">Save</button>', name: 'Save', desc: 'Keyboard: Ctrl+S' },
  { id: 'desc-title-used-as-name', html: '<button id=t title="Close"></button>', desc: '' },
  { id: 'desc-describedby-beats-title', html: '<button id=t title=T aria-describedby=d>B</button><span id=d>D</span>', desc: 'D' },

  // ------------------------------------------------ Material-style markup
  { id: 'mat-button', html: '<button id=t class="mdc-button mat-mdc-button"><span class="mat-mdc-button-persistent-ripple"></span><span class="mdc-button__label">Save changes</span><span class="mat-focus-indicator"></span><span class="mat-mdc-button-touch-target"></span></button>', role: 'button', name: 'Save changes' },
  { id: 'mat-icon-button', html: '<button id=t class="mat-mdc-icon-button" aria-label="Delete row"><mat-icon aria-hidden="true" class="material-icons">delete</mat-icon></button>', role: 'button', name: 'Delete row' },
  { id: 'mat-form-field', html: '<div class="mat-mdc-form-field"><label class="mdc-floating-label" for=t><mat-label>Email</mat-label><span aria-hidden="true" class="mat-mdc-form-field-required-marker"> *</span></label><input id=t class="mat-mdc-input-element" required></div>', role: 'textbox', name: 'Email' },
  { id: 'mat-checkbox', html: '<div class="mdc-form-field"><div class="mdc-checkbox"><input type=checkbox id=t class="mdc-checkbox__native-control"><div class="mdc-checkbox__background"></div></div><label for=t>Remember me</label></div>', role: 'checkbox', name: 'Remember me' },
  { id: 'mat-select', html: '<mat-label id=ml>Favorite food</mat-label><div id=t role=combobox tabindex=0 aria-labelledby=ml aria-expanded=false aria-haspopup=listbox><span>Pizza</span></div>', role: 'combobox', name: 'Favorite food', expanded: false },
  { id: 'mat-tab', html: '<div role=tablist><div id=t role=tab aria-selected=false class="mdc-tab"><span class="mdc-tab__content"><span class="mdc-tab__text-label">Second</span></span><span class="mdc-tab-indicator"></span></div></div>', role: 'tab', name: 'Second', selected: false },
  { id: 'mat-slide-toggle', html: '<button id=t role=switch aria-checked=false class="mdc-switch"><span class="mdc-switch__track"></span></button><label for=t>Dark mode</label>', role: 'switch', name: 'Dark mode', checked: false },

  // ------------------------------------------------ Bootstrap-style markup
  { id: 'bs-btn-close', html: '<button id=t type=button class="btn-close" aria-label="Close"></button>', role: 'button', name: 'Close' },
  { id: 'bs-dropdown-toggle', html: '<button id=t class="btn dropdown-toggle" type=button data-bs-toggle=dropdown aria-expanded=false>Actions</button>', role: 'button', name: 'Actions', expanded: false },
  { id: 'bs-form-floating', html: '<div class="form-floating"><input id=t class="form-control" placeholder="name@example.com"><label for=t>Email address</label></div>', name: 'Email address' },
  { id: 'bs-visually-hidden', html: VH + '<button id=t class="btn"><span class="spinner-border" aria-hidden=true></span><span class="visually-hidden">Loading...</span></button>', name: 'Loading...' },
  { id: 'bs-nav-tabs', html: '<ul class="nav nav-tabs" role=tablist><li class="nav-item" role=presentation><button id=t class="nav-link active" role=tab aria-selected=true>Profile</button></li></ul>', role: 'tab', name: 'Profile', selected: true },
  { id: 'bs-nav-li-presentation', html: '<ul class="nav nav-tabs" role=tablist><li id=t class="nav-item" role=presentation><button role=tab>Profile</button></li></ul>', role: 'presentation' },
  { id: 'bs-alert', html: '<div id=t class="alert alert-success" role=alert>Saved!</div>', role: 'alert', name: '' },
  { id: 'bs-input-group', html: '<div class="input-group"><span class="input-group-text" id=at>@</span><input id=t class="form-control" placeholder="Username" aria-label="Username" aria-describedby=at></div>', name: 'Username', desc: '@' },
  { id: 'bs-switch', html: '<div class="form-check form-switch"><input class="form-check-input" type=checkbox role=switch id=t checked><label class="form-check-label" for=t>Notifications</label></div>', role: 'switch', name: 'Notifications', checked: true },
  { id: 'bs-modal', html: '<div class="modal" id=t tabindex=-1 role=dialog aria-labelledby=mt style="display:block"><div class="modal-dialog"><h5 class="modal-title" id=mt>Edit user</h5></div></div>', role: 'dialog', name: 'Edit user' },
  { id: 'bs-pagination-current', html: '<nav aria-label="Page navigation"><ul class="pagination"><li class="page-item active"><a id=t class="page-link" href="#" aria-current="page">2</a></li></ul></nav>', role: 'link', name: '2' },
  { id: 'bs-nav-landmark-name', html: '<nav id=t aria-label="breadcrumb"><ol class="breadcrumb"><li>Home</li></ol></nav>', role: 'navigation', name: 'breadcrumb' },

  // ------------------------------------------------ React-style markup
  { id: 'react-div-button', html: '<div id=t role=button tabindex=0 class="css-1x2y3z">Add to cart</div>', role: 'button', name: 'Add to cart' },
  { id: 'react-icon-sr-only', html: VH + '<button id=t><svg aria-hidden=true focusable=false width=8 height=8><path d="M0 0h8v8H0z"/></svg><span class="sr-only">Open menu</span></button>', name: 'Open menu' },
  { id: 'react-toggle-pressed', html: '<button id=t aria-pressed=true>Bold</button>', role: 'button', pressed: true, name: 'Bold' },
  { id: 'react-toggle-not-pressed', html: '<button id=t>Italic</button>', role: 'button', pressed: false },
  { id: 'react-pressed-mixed', html: '<button id=t aria-pressed=mixed>Mixed</button>', pressed: 'mixed' },
  { id: 'react-combobox-input', html: '<label id=cl for=t>City</label><input id=t role=combobox aria-expanded=true aria-controls=lb aria-autocomplete=list value="Ams"><ul id=lb role=listbox><li role=option aria-selected=true>Amsterdam</li></ul>', role: 'combobox', name: 'City', expanded: true },
  { id: 'react-listbox-option', html: '<ul role=listbox aria-label=Cities><li id=t role=option aria-selected=false>Berlin</li></ul>', role: 'option', name: 'Berlin', selected: false },
  { id: 'react-accordion', html: '<h3><button id=t aria-expanded=true aria-controls=p1>Shipping</button></h3><div id=p1 role=region aria-labelledby=t>...</div>', role: 'button', name: 'Shipping', expanded: true },
  { id: 'react-accordion-region', html: '<h3><button id=b aria-expanded=true>Shipping</button></h3><div id=t role=region aria-labelledby=b>...</div>', role: 'region', name: 'Shipping' },
  { id: 'react-labelled-by-heading', html: '<h2 id=h>Payment</h2><form id=t aria-labelledby=h><input></form>', role: 'form', name: 'Payment' },
  { id: 'react-menu', html: '<div role=menu aria-label=File><div id=t role=menuitem tabindex=-1>New file <kbd>⌘N</kbd></div></div>', role: 'menuitem', name: 'New file ⌘N' },
  { id: 'react-link-button-nested', html: '<a id=t href="/p/1"><div class="card"><h3>Product</h3><p>€ 9</p></div></a>', role: 'link', name: 'Product € 9' },

  // ------------------------------------------------ custom elements and shadow DOM
  {
    id: 'shadow-slotted-button',
    html: '<x-btn id=h>Buy now</x-btn>',
    setup: "h.attachShadow({mode:'open'}).innerHTML = '<button id=t><slot></slot></button>'",
    shadow: '#h',
    role: 'button',
    name: 'Buy now',
  },
  {
    id: 'shadow-labelledby-inside',
    html: '<x-field id=h></x-field>',
    setup: "h.attachShadow({mode:'open'}).innerHTML = '<span id=l>Zip code</span><input id=t aria-labelledby=l>'",
    shadow: '#h',
    role: 'textbox',
    name: 'Zip code',
  },
  {
    id: 'shadow-label-for-inside',
    html: '<x-field id=h></x-field>',
    setup: "h.attachShadow({mode:'open'}).innerHTML = '<label for=t>City</label><input id=t>'",
    shadow: '#h',
    name: 'City',
  },
  {
    id: 'shadow-host-role',
    html: '<x-toggle id=t role=switch aria-checked=true tabindex=0></x-toggle>',
    setup: "t.attachShadow({mode:'open'}).innerHTML = '<span>Airplane mode</span>'",
    role: 'switch',
    name: 'Airplane mode',
    checked: true,
  },
  {
    id: 'shadow-content-in-host-name',
    html: '<button id=t><x-icon-label id=h></x-icon-label></button>',
    setup: "h.attachShadow({mode:'open'}).innerHTML = '<b>Export</b> <i>CSV</i>'",
    name: 'Export CSV',
  },
  {
    id: 'shadow-unslotted-light-text-ignored',
    html: '<button id=t><x-c id=h>light</x-c></button>',
    setup: "h.attachShadow({mode:'open'}).innerHTML = '<span>shadow only</span>'",
    name: 'shadow only',
  },
  {
    id: 'shadow-slot-fallback',
    html: '<button id=t><x-c id=h></x-c></button>',
    setup: "h.attachShadow({mode:'open'}).innerHTML = '<slot>Default text</slot>'",
    name: 'Default text',
  },
  {
    id: 'shadow-aria-hidden-host',
    html: '<button id=t>Text<x-c id=h aria-hidden=true></x-c></button>',
    setup: "h.attachShadow({mode:'open'}).innerHTML = '<span>icon</span>'",
    name: 'Text',
  },
];
