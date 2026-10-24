# Recording journeys

`eztest record <url>` and the Studio's Record page open the app in a visible browser. What you do there is
written as plain-English `.ez` steps, each one parsed back with the grammar before it is kept, so the
recording means exactly what its text says. `--verify` (or `verifyRecording()` in code) replays it at once.

## What is recorded

| You do | The journey says |
|---|---|
| Click, double-click, right-click | `Click the "Sign in" button` · `Double-click the "Order 7" row` · `Right-click #hot-spot` |
| Type in a field, or in a rich-text editor | `Type "bob" into the Username field` · `Type "Hello" into the "Rich Text Area" field` (contenteditable, TinyMCE) |
| Type a password | `Type "${password}" into the Password field` (the value is never recorded; supply it at run time) |
| Choose, tick, upload | `Select "Option 2" from #dropdown` · `Check the Newsletter checkbox` · `Upload "a.pdf" to the Avatar field` |
| Press keys | `Press Enter in the Search field` · `Press Tab in the Username field` · `Press Escape` · `Press Control+K` (keys that only edit a field's text are recorded as the text) |
| Point at a menu or card that only shows on hover, then click in it | `Hover over the 1st "User Avatar" image` before the click (CSS `:hover` rules and mouseenter menus) |
| Drag and drop | `Drag #column-a to #column-b` (HTML5 drag and drop, and mouse drags such as sortable lists) |
| Act inside an iframe or frameset | `In frame "frame-top" > "frame-middle"` … `End`: the frame's name, title, id or address, the way the runner finds it |
| Answer an alert, confirm or prompt | `Accept the next alert` · `Dismiss the next confirm dialog` · `Answer the next prompt with "Ada"` before the click, and `Expect a confirm dialog saying "…"` after it |
| Click something that opens a new tab, window or popup | `Click the "Open report" link and switch to the new tab` with `Expect URL contains "/report"` |
| Go back to the first tab, or to another one | `Switch back to the main tab` · `Switch to tab 2` |
| Close a tab yourself | `Close the tab` (not when the page closes its own window) |
| Click a download link | `Download the "report.pdf" link as reportFile` with `Expect download reportFile exists` |
| Alt+Click an element | An expectation on it: `Expect the Status field has value "Open"` · `Expect testid=total contains "49.50"` |
| Type an expectation in Studio | It is attached to the last step, in the tab you are looking at |

A JavaScript dialog stays open for you to answer while recording; how you answered it is what gets recorded.

## How elements are named

The recorder measures, on the live page, which words find exactly one element, best first:

1. the element's accessible name or label (`the "Sign in" button`, `the Email field`);
2. for a name that repeats: its row (`the "Edit" link in the row containing "Bach"`), the table or form around
   the row when the same rows appear twice (`... inside #table1`), a named landmark
   (`the "New order" link inside the "Main" navigation`), or its position (`the 2nd "Edit" button`);
3. a test id or a unique id (`testid=order-total`, `#dropdown`);
4. its text (`the "BOTTOM" text`, `the 1st "Let's have some different text!" text`), shadow DOM and slots included;
5. a CSS path, as a last resort, with a warning that says why.

Elements inside open shadow roots are named the same way; a CSS path into a web component chains the host
(`css=my-card >> css=button.save`). Address checks leave out one-time parts of the path (ids, tokens).
