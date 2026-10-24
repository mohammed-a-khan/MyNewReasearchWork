# Documents: extraction, OCR, layout and visual comparison

EZTest reads business documents (PDF) into one model, the Canonical Document Model (`@mohammed-a-khan/eztest/docs`). Pages hold lines, lines hold column segments, and segments hold positioned text items. On top of that sit named fields and typed tables. Every value keeps its page, its box, how it was read (`method`) and how sure the reader is (`confidence`). Reconciliation, three-way checks, the PDF diff and the reports all work on this model, whatever the source.

## Extraction methods

```ts
import { extractPdf } from '@mohammed-a-khan/eztest/docs';

const doc = await extractPdf('invoice.pdf', { method: 'auto', template: 'templates/invoice.yaml' });
```

| method | What it reads | Needs |
|---|---|---|
| `text-layer` (default) | The PDF's text layer: positioned text runs, grouped into lines by baseline and into segments by column gaps | nothing |
| `layout` | The text layer plus layout analysis: ruling lines, two-column reading order, template-free table detection | nothing |
| `ocr` | Every page rendered and read by OCR; the words become positioned items | `@napi-rs/canvas`, `tesseract.js` and `@tesseract.js-data/eng` |
| `auto` | The text layer, and OCR for the pages that have no text layer (scanned pages) | the OCR packages, for scanned pages only |
| `vision` | Not supported: EZTest does not send documents to a model service. The error says so and names the other methods | |

### Scanned and image-only PDFs (OCR)

With `method: 'ocr'` (or `'auto'` for pages without text), each page is rendered with pdf.js onto a canvas from `@napi-rs/canvas`, at 300 dpi by default. The image is read by tesseract.js, locally in WebAssembly. No service is called, and language data is never downloaded at run time: it comes from `@tesseract.js-data/<lang>`, or from `ocr.langPath`.

- `@napi-rs/canvas` is an optional dependency of `pdfjs-dist`, so it is normally installed already. When it is missing (optional dependencies omitted, or a platform without a prebuilt binary), rendering fails with `DOCS_CANVAS_MISSING` and the install command.
- `tesseract.js` and its language data are optional peers: `npm install -D tesseract.js @tesseract.js-data/eng`. Without them OCR fails with `DOCS_OCR_MISSING`. In `auto` mode, a page with no text layer gets an `OCR_UNAVAILABLE` finding instead of a crash.

The recognised words become text items in PDF points, with the recogniser's confidence (0..1). Words of one recognised line share a baseline, and font size is estimated from the line height. So line grouping, label-anchored fields, regex fields and table templates work on OCR output unchanged. Values read on an OCR page say `method: "ocr"`, and their confidence is capped by the mean OCR confidence of the words inside the value's box.

**A second look at numbers.** When a template field or table column is typed `number`, `currency` or `percent` and the OCR text of a value does not read as a number (a lone "1" read as "il" or "|"), the value's box is read again as a single line, limited to digits and number punctuation. Only a result that parses as a number replaces the value, with that read's confidence.

```ts
await extractPdf(scan, {
  method: 'auto',
  template,
  ocr: { lang: 'eng', dpi: 300, minConfidence: 30, pageSegMode: 3 },
});
```

`ocr.engine` accepts any object with `recognize(png) -> words` (and optionally `recognizeRegion`), for another local OCR engine.

**Measured accuracy.** The suite builds scanned invoices: an invoice PDF is rendered to gray pixels, dimmed, with random noise, and written back as an image-only PDF by EZTest's own minimal PDF writer (`writeImagePdf`), so there is no text layer at all. Reading those with `method: 'auto'` and the invoice template:

| Scan | Fields (4) | Amounts (qty, unit price, line total) | Characters |
|---|---|---|---|
| 300 dpi, light noise | 4/4 | 59/60 | 99.4% |
| 200 dpi, noise (the test case, 12 lines) | 4/4 | 36/36 | 99.85% |
| 200 dpi, noise, 20 lines | 4/4 | 59/60 | 99.7% |
| 150 dpi, heavy noise | 4/4 | 60/60 | 100% |
| 120 dpi, heavy noise | 4/4 | 59/60 | 98.4% |
| 100 dpi, noise | 3/4 | 60/60 | 96.6% |

These are synthetic scans of clean digital text (Helvetica, no skew, no stains). Real scans of real paper read worse; check the `confidence` of the values you assert on, and keep a human review for low-confidence values. The test asserts at least 97% of amounts and characters, and every field.

### Layout analysis

`method: 'layout'` reads the text layer and also:

- **Ruling lines.** Horizontal and vertical lines from the page's drawing operators: stroked lines, rectangle borders and thin filled rectangles. They are kept on `page.rulings`.
- **Columns.** A page with two-column prose (a vertical gutter that no text crosses for several lines, with long runs of text on both sides) is read column by column. With the text layer alone, lines are read straight across the gutter. Tables, whose cells are short, are not mistaken for columns.
- **Tables without a template.** When the template defines no tables (or with `detectTables: true`), tables are found two ways. Ruling-line grids become cells, and the first row with text is the header. Runs of lines whose segments line up in the same columns become a table too, and a line with nothing in the first column continues the row above. Detected tables are named `table-p<page>-<n>`, with typed cells (`normalized` values) and `method: "layout"` (or `"ocr"` on OCR pages).

A template's fields and tables work the same on `layout` as on `text-layer`.

### Fields without a template

`autoFields(doc)` (used by the PDF diff) turns `Label:` segments followed by a value into fields. It also reads `Label: value` printed as one text run ("Invoice No: INV-1001"): the label must start with a letter, so times ("10:30"), URLs and ratios are not split. The value's box is the part of the run after the label.

## Visual comparison

Text extraction misses what only shows on the page: a moved logo, a wrong font, a table border, a stamp. Visual comparison renders both PDFs page by page and compares the pixels with pixelmatch.

```text
Download the "Invoice" link as invoice
Expect document invoice to look like "baselines/invoice.pdf" within 0.5% ignoring page 1 400,40,150,20 and 40,780,200,20 on page 1
```

- The first document is the one under test: a download in the journey (its ledger key) or a file in the project. The second is the expected document, usually a baseline file.
- `within 0.5%` is the share of differing pixels a page may have. `within 40 pixels` is an absolute budget. Without either, any visible difference fails (anti-aliasing differences are ignored).
- `ignoring` lists regions to mask, in PDF points from the top-left corner of the page, as `x,y,width,height`. `page N` before a region, or `on page N` after it, limits it to one page; otherwise it applies to every page. Separate regions with `and` or `;`. Masked regions are painted the same on both sides, so dates, generated ids and signatures never count.
- A page count difference, a missing page or a page of a different size fails.

Evidence: a diff image for every compared page (differences in red, masked regions in light blue), the expected and actual renderings of failing pages, and an HTML report with the three side by side. The step's failure message names each failing page with its pixel count and percentage, and the evidence ids.

In code:

```ts
import { compareDocumentsVisually, renderVisualHtml } from '@mohammed-a-khan/eztest/docs';

const r = await compareDocumentsVisually('out/invoice.pdf', 'baselines/invoice.pdf', {
  dpi: 100, threshold: 0.1, maxDiffRatio: 0.005, masks: [{ page: 1, x: 400, y: 40, width: 150, height: 20 }],
});
if (!r.passed) console.log(r.summary, r.pages.filter((p) => !p.passed).map((p) => p.diffPixels));
```

`renderPdfPages(pdf, { dpi })` gives the rendered pages (RGBA and PNG) for other uses.

## Limits

- OCR quality depends on the scan. Skewed, rotated or very low resolution scans, handwriting and stamps are read poorly or not at all; EZTest does not deskew or despeckle.
- Layout table detection handles grids and aligned columns; merged cells, nested tables and tables without either rules or alignment need a template.
- Column detection finds one two-column region per page, not three or more columns or mixed layouts.
- Visual comparison compares renderings by pdf.js. Two PDFs that print identically but embed fonts differently can render with small differences: use a tolerance.
