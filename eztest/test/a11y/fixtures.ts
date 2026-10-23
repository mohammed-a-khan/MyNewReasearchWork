/**
 * Per-rule fixture pages for EZTest's accessibility engine: for every rule a
 * failing variant (or one that needs review) and a passing variant. Bodies
 * are wrapped in a conforming page (lang, title, main, h1) unless `doc` is
 * set, in which case each variant is a whole document.
 */

export interface RuleFixture {
  rule: string;
  /** Markup that must produce a violation of the rule. */
  fail?: string;
  /** Markup that must produce a needs-review result of the rule. */
  review?: string;
  /** Markup with no violation and nothing to review for the rule. */
  pass?: string;
  /** Variants are complete documents. */
  doc?: boolean;
}

export const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

export function page(body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title>${head}</head><body><main><h1>Fixture</h1>${body}</main></body></html>`;
}

const LONG = 'Accessible content is content everyone can use. '.repeat(6);

export const FIXTURES: RuleFixture[] = [
  // text alternatives
  { rule: 'text-alt.img', fail: `<img src="${GIF}" width="20" height="20">`, review: `<img src="${GIF}" alt="IMG_0042.jpg" width="20" height="20">`, pass: `<img src="${GIF}" alt="Company logo" width="20" height="20"><img src="${GIF}" alt="" width="20" height="20">` },
  { rule: 'text-alt.area', fail: `<img src="${GIF}" usemap="#m" alt="Floor plan" width="50" height="50"><map name="m"><area href="/a" shape="rect" coords="0,0,10,10"></map>`, pass: `<img src="${GIF}" usemap="#m" alt="Floor plan" width="50" height="50"><map name="m"><area href="/a" alt="Kitchen" shape="rect" coords="0,0,10,10"></map>` },
  { rule: 'text-alt.input-image', fail: `<form><input type="image" src="${GIF}" width="20" height="20"></form>`, pass: `<form><input type="image" src="${GIF}" alt="Search" width="20" height="20"></form>` },
  { rule: 'text-alt.role-img', fail: `<div role="img" style="width:20px;height:20px;background:red"></div>`, pass: `<svg role="img" aria-label="Sales chart" width="20" height="20"></svg><svg role="img" width="20" height="20"><title>Trend</title></svg>` },
  { rule: 'text-alt.object', fail: `<object data="${GIF}" type="image/gif" style="display:block;width:60px;height:30px"></object>`, pass: `<object data="${GIF}" type="image/gif" aria-label="Release diagram" style="display:block;width:60px;height:30px"></object>` },

  // names and labels
  { rule: 'name.button', fail: `<button id="b"></button>`, pass: `<button>Save</button><button aria-label="Close">×</button><input type="submit">` },
  { rule: 'name.link', fail: `<a href="/x"><span></span></a>`, pass: `<a href="/x">Home</a><a href="/y"><img src="${GIF}" alt="Profile" width="10" height="10"></a>` },
  { rule: 'name.form-field', fail: `<input type="text"><select><option>A</option></select>`, pass: `<label>Email <input type="email"></label><input aria-label="Search"><label for="s">Size</label><select id="s"><option>S</option></select>` },
  { rule: 'name.widget', fail: `<div role="tablist" aria-label="Sections"><div role="tab" tabindex="0" aria-selected="true"></div></div>`, pass: `<div role="tablist" aria-label="Sections"><div role="tab" tabindex="0" aria-selected="true">Overview</div></div>` },
  { rule: 'name.container', fail: `<div role="radiogroup"><label><input type="radio" name="r"> A</label></div>`, pass: `<div role="radiogroup" aria-label="Size"><label><input type="radio" name="r"> A</label></div>` },
  { rule: 'name.frame', fail: `<iframe srcdoc="<p>Frame</p>"></iframe>`, pass: `<iframe title="Help article" srcdoc="<p>Frame</p>"></iframe>` },
  { rule: 'name.label-in-name', fail: `<button aria-label="Submit the form">Send</button>`, pass: `<button aria-label="Send the form">Send</button><button>Plain</button>` },
  { rule: 'label.visible', review: `<input type="text" placeholder="Your name">`, pass: `<label for="n">Name</label><input id="n" placeholder="Jane Doe">` },
  { rule: 'label.for-target', fail: `<label for="nowhere">Phone</label>`, pass: `<label for="ph">Phone</label><input id="ph" type="tel">` },

  // ARIA
  { rule: 'aria.role-valid', fail: `<div role="widget">x</div><div role="buton">y</div>`, pass: `<div role="foo button" tabindex="0">x</div><div role="note">y</div>` },
  { rule: 'aria.attr-name', fail: `<div aria-labeledby="x">x</div>`, pass: `<div aria-live="polite">x</div>` },
  { rule: 'aria.attr-value', fail: `<div role="checkbox" aria-checked="yes" tabindex="0" aria-label="A">x</div><h2 aria-level="two">t</h2>`, pass: `<div role="checkbox" aria-checked="mixed" tabindex="0" aria-label="A">x</div><div aria-live="polite" aria-relevant="additions text">y</div>` },
  { rule: 'aria.attr-required', fail: `<div role="slider" tabindex="0" aria-label="Volume">x</div>`, pass: `<div role="slider" tabindex="0" aria-label="Volume" aria-valuenow="5">x</div><input type="checkbox" role="switch" aria-label="Wi-Fi">` },
  { rule: 'aria.attr-allowed', fail: `<button aria-checked="true">x</button><label aria-checked="true">L <input></label>`, pass: `<button aria-pressed="true">x</button><div role="option" aria-selected="true">y</div><input type="date" aria-label="Day" aria-required="true">` },
  { rule: 'aria.attr-prohibited', fail: `<div aria-label="Panel">x</div>`, pass: `<div role="region" aria-label="Panel">x</div><span>y</span>` },
  { rule: 'aria.reference', fail: `<input aria-labelledby="missing">`, pass: `<span id="l">Name</span><input aria-labelledby="l">` },
  { rule: 'aria.parent', fail: `<div role="tab">x</div>`, pass: `<div role="tablist" aria-label="T"><div role="tab">x</div></div>` },
  { rule: 'aria.children', fail: `<div role="list"><div role="button" tabindex="0">x</div></div>`, review: `<div role="listbox" aria-label="Empty"></div>`, pass: `<div role="list"><div role="listitem">x</div><div><div role="listitem">y</div></div></div>` },
  { rule: 'aria.hidden-focusable', fail: `<div aria-hidden="true"><button>Hidden</button></div>`, pass: `<div aria-hidden="true"><button tabindex="-1">Hidden</button></div><div aria-hidden="true" inert><button>Inert</button></div>` },
  { rule: 'aria.hidden-body', doc: true, fail: `<!doctype html><html lang="en"><head><title>T</title></head><body aria-hidden="true"><main><h1>x</h1></main></body></html>`, pass: page('') },
  { rule: 'aria.nested-interactive', fail: `<div role="button" tabindex="0">Card <a href="/more">more</a></div>`, pass: `<div role="button" tabindex="0">Card <span>more</span></div>` },
  { rule: 'aria.role-allowed', fail: `<button role="heading" aria-level="2">Title</button><label role="button">L</label>`, pass: `<a href="/t" role="tab">Tab</a><ul role="menu"><li role="menuitem">x</li></ul><div role="note">n</div>` },
  { rule: 'aria.presentation-conflict', fail: `<button role="none">x</button>`, pass: `<span role="none">x</span>` },
  { rule: 'aria.deprecated', fail: `<div aria-grabbed="false">x</div>`, pass: `<div aria-busy="false">x</div>` },

  // colour
  { rule: 'contrast.text', fail: `<p style="color:#999;background:#fff">Grey text on white</p>`, review: `<p style="color:#777;background:linear-gradient(#fff,#000);padding:20px">Text on a gradient</p>`, pass: `<p style="color:#595959;background:#fff">Dark grey text</p><p style="color:#949494;background:#fff;font-size:24px">Large text at 3:1</p><button disabled style="color:#bbb">Disabled</button>` },
  { rule: 'contrast.text-enhanced', fail: `<p style="color:#767676;background:#fff">AA but not AAA</p>`, pass: `<p style="color:#000;background:#fff">Black</p>` },
  { rule: 'contrast.ui-component', fail: `<input aria-label="Name" style="border:1px solid #ddd;background:#fff">`, review: `<input aria-label="Name" style="border:0;background:#fff">`, pass: `<input aria-label="Name" style="border:1px solid #767676;background:#fff"><input aria-label="Filled" style="border:0;background:#555;color:#fff">` },
  { rule: 'contrast.link-in-text', fail: `<p style="color:#000">Please read the <a href="/t" style="color:#222;text-decoration:none">terms of service</a> before you continue.</p>`, pass: `<p style="color:#000">Please read the <a href="/t" style="color:#222">terms of service</a> before you continue.</p><ul><li><a href="/x" style="text-decoration:none">Nav link</a></li></ul><table><tr><th style="color:#000"><a href="/c" style="color:#222;text-decoration:none">Checkout case</a><span style="display:block">suites/checkout/guest-checkout.ez</span></th></tr></table>` },

  // document and language
  { rule: 'page.title', doc: true, fail: `<!doctype html><html lang="en"><head><title> </title></head><body><main><h1>x</h1></main></body></html>`, pass: page('') },
  { rule: 'lang.page', doc: true, fail: `<!doctype html><html><head><title>T</title></head><body><main><h1>x</h1></main></body></html>`, pass: page('') },
  { rule: 'lang.valid', fail: `<p lang="english">Hello</p><p lang="en_US">Hi</p>`, pass: `<p lang="fr-CA">Salut</p><p lang="zh-Hant-TW">你好</p>` },

  // headings and landmarks
  { rule: 'heading.order', fail: `<h3>Skipped a level</h3>`, pass: `<h2>Section</h2><h3>Sub</h3><h2>Next</h2>` },
  { rule: 'heading.empty', fail: `<h2></h2><h3 aria-hidden="false"><span aria-hidden="true">x</span></h3>`, pass: `<h2>Section</h2>` },
  { rule: 'heading.level-one', doc: true, fail: `<!doctype html><html lang="en"><head><title>T</title></head><body><main><h2>No h1</h2></main></body></html>`, pass: page('') },
  { rule: 'landmark.main', doc: true, fail: `<!doctype html><html lang="en"><head><title>T</title></head><body><h1>x</h1><p>No main</p></body></html>`, pass: page('') },
  { rule: 'landmark.single', doc: true, fail: `<!doctype html><html lang="en"><head><title>T</title></head><body><main><h1>a</h1></main><main>b</main></body></html>`, pass: page('') },
  { rule: 'landmark.top-level', doc: true, fail: `<!doctype html><html lang="en"><head><title>T</title></head><body><nav aria-label="x"><main><h1>a</h1></main></nav></body></html>`, pass: page('') },
  { rule: 'landmark.unique', fail: `<nav><a href="/a">a</a></nav><nav><a href="/b">b</a></nav>`, pass: `<nav aria-label="Primary"><a href="/a">a</a></nav><nav aria-label="Footer"><a href="/b">b</a></nav>` },
  { rule: 'landmark.contained', doc: true, fail: `<!doctype html><html lang="en"><head><title>T</title></head><body><main><h1>x</h1></main><p>Stray text outside</p></body></html>`, pass: page('<p>Inside</p>') },
  { rule: 'bypass.blocks', doc: true, fail: `<!doctype html><html lang="en"><head><title>T</title></head><body><a href="/a">a</a><a href="/b">b</a><p>Content</p></body></html>`, pass: page('<a href="/a">a</a>') },
  { rule: 'bypass.skip-link', fail: `<a href="#content">Skip to main content</a>`, pass: `<a href="#c">Skip to main content</a><div id="c">Content</div>` },

  // ids
  { rule: 'id.duplicate-referenced', fail: `<label for="d">Email</label><input id="d"><input id="d" aria-label="Other">`, pass: `<label for="e">Email</label><input id="e">` },
  { rule: 'id.duplicate', fail: `<div id="x">a</div><div id="x">b</div>`, pass: `<div id="y">a</div>` },

  // tables
  { rule: 'table.headers-attr', fail: `<table><tr><th id="h">H</th></tr><tr><td headers="nope">1</td></tr></table>`, pass: `<table><tr><th id="h">H</th></tr><tr><td headers="h">1</td></tr></table>` },
  { rule: 'table.scope', fail: `<table><tr><td scope="col">x</td></tr></table><table><tr><th scope="column">y</th></tr></table>`, pass: `<table><tr><th scope="col">x</th></tr></table>` },
  { rule: 'table.has-headers', review: `<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>`, pass: `<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><table role="presentation"><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>` },
  { rule: 'table.header-empty', fail: `<table><tr><th></th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>`, pass: `<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>` },
  { rule: 'table.caption', review: `<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>`, pass: `<table><caption>Totals</caption><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>` },

  // lists
  { rule: 'list.structure', fail: `<ul><div>Not an item</div></ul>`, pass: `<ul><li>Item</li><template></template></ul>` },
  { rule: 'list.item-context', fail: `<div><li>Orphan</li></div>`, pass: `<ol><li>Item</li></ol>` },
  { rule: 'list.definition', fail: `<dl><p>Wrong</p></dl><dd>Orphan</dd>`, pass: `<dl><dt>Term</dt><dd>Desc</dd><div><dt>T2</dt><dd>D2</dd></div></dl>` },

  // keyboard and focus (static)
  { rule: 'focus.tabindex-positive', fail: `<button tabindex="2">x</button>`, pass: `<button tabindex="0">x</button><div tabindex="-1">y</div>` },
  { rule: 'keyboard.scrollable', fail: `<div style="height:40px;overflow:auto"><p>${LONG}</p></div>`, pass: `<div style="height:40px;overflow:auto" tabindex="0" aria-label="Notes"><p>${LONG}</p></div>` },
  { rule: 'keyboard.frame-tabindex', fail: `<iframe title="Form" tabindex="-1" srcdoc="<button>Go</button>"></iframe>`, pass: `<iframe title="Text" tabindex="-1" srcdoc="<p>Only text</p>"></iframe>` },

  // pointer, zoom, forms
  { rule: 'target.size', fail: `<div><button style="width:16px;height:16px;padding:0;margin:0">a</button><button style="width:16px;height:16px;padding:0;margin:0">b</button></div>`, pass: `<button style="width:16px;height:16px;padding:0">a</button><div style="height:40px"></div><button style="width:16px;height:16px;padding:0">b</button><p>Text with an <a href="/i">inline link</a> in a long sentence.</p><button style="width:30px;height:30px">c</button>` },
  { rule: 'target.size-enhanced', fail: `<button style="width:30px;height:30px">a</button>`, pass: `<button style="width:48px;height:48px">a</button>` },
  { rule: 'zoom.viewport', doc: true, fail: page('', '<meta name="viewport" content="width=device-width, user-scalable=no">'), pass: page('', '<meta name="viewport" content="width=device-width, initial-scale=1">') },
  { rule: 'timing.meta-refresh', doc: true, fail: page('', '<meta http-equiv="refresh" content="300">'), pass: page('', '<meta http-equiv="refresh" content="80000">') },
  { rule: 'form.autocomplete', fail: `<input aria-label="E-mail" autocomplete="mail"><input aria-label="Phone" autocomplete="home email-address">`, pass: `<input aria-label="E-mail" autocomplete="shipping email"><input aria-label="Phone" autocomplete="section-a work tel"><input aria-label="Code" autocomplete="off">` },
  { rule: 'frame.title-unique', fail: `<iframe title="Ad" src="data:text/html,a"></iframe><iframe title="Ad" src="data:text/html,b"></iframe>`, pass: `<iframe title="Ad one" src="data:text/html,a"></iframe><iframe title="Ad two" src="data:text/html,b"></iframe>` },

  // media and motion
  { rule: 'media.captions', review: `<video controls width="100" height="50"></video>`, pass: `<video controls width="100" height="50"><track kind="captions" src="data:text/vtt,WEBVTT"></video>` },
  { rule: 'media.audio-description', review: `<video controls width="100" height="50"></video>`, pass: `<video controls width="100" height="50"><track kind="descriptions" src="data:text/vtt,WEBVTT"></video>` },
  { rule: 'media.audio-alternative', review: `<audio controls></audio>` },
  { rule: 'media.autoplay', review: `<audio autoplay></audio>`, pass: `<audio autoplay controls></audio><video autoplay muted width="10" height="10"></video>` },
  { rule: 'motion.blink', fail: `<blink>New!</blink>` },
  { rule: 'motion.marquee', fail: `<marquee>Breaking news</marquee>` },
  { rule: 'layout.orientation', doc: true, fail: page('', '<style>@media (orientation: portrait) { html { transform: rotate(90deg); } }</style>'), pass: page('', '<style>@media (orientation: portrait) { body { font-size: 18px; } }</style>') },

  // dynamic
  { rule: 'layout.reflow', fail: `<div style="width:900px">A fixed-width block of text that cannot reflow to the viewport.</div>`, pass: `<p>Short text that wraps.</p>` },
  { rule: 'text.spacing', fail: `<div style="height:20px;overflow:hidden;width:220px;font-size:16px;line-height:1.2">A single line of text here</div>`, pass: `<div style="min-height:20px;overflow:hidden;width:220px">A single line of text here</div>` },
  {
    rule: 'keyboard.trap',
    fail: `<button id="a">Before</button><div id="trap"><button id="t1">One</button><button id="t2">Two</button></div><button id="z">After</button>
      <script>document.getElementById('t2').addEventListener('keydown', (e) => { if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); document.getElementById('t1').focus(); } });</script>`,
    pass: `<button>Before</button><div><button>One</button><button>Two</button></div><button>After</button>`,
  },
  { rule: 'focus.visible', fail: `<style>button:focus { outline: none; }</style><button>No ring</button>`, pass: `<button>Default ring</button><style>.c:focus-visible { outline: none; box-shadow: 0 0 0 3px #000; }</style><button class="c">Custom ring</button>` },
  { rule: 'focus.hidden-stop', fail: `<a href="/x" style="position:absolute;left:-9999px">Invisible stop</a>`, pass: `<style>.s { position: absolute; left: -9999px; } .s:focus { left: 0; }</style><a class="s" href="#m">Skip link</a><span id="m"></span>` },
  { rule: 'focus.order', review: `<button style="position:absolute;top:300px;left:300px">First</button><button style="position:absolute;top:10px;left:10px">Second</button>`, pass: `<button>First</button><button>Second</button>` },
  { rule: 'focus.not-obscured', fail: `<div style="position:fixed;top:0;left:0;right:0;height:200px;background:#fff;z-index:9">Sticky banner</div><button style="position:absolute;top:40px;left:20px">Covered</button>`, pass: `<button>Clear</button>` },
];
