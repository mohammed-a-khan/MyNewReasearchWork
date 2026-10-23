/**
 * Rich-text editors (contenteditable, Quill DOM, CKEditor 5 DOM, real TinyMCE
 * in its iframe), sliders (real noUiSlider, real MUI, WAI-ARIA), masked inputs
 * (real IMask), drop zones, canvas charts (real Chart.js and ECharts, a
 * Highcharts-style global, a data-table fallback, an opaque canvas) and an
 * infinite feed.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import type { EnterpriseApp } from '../../examples/enterprise-app/server.js';
import { componentEvidence, expectPasses, runEz, startApp, stepById } from './components-helpers.js';

let app: EnterpriseApp;
let files: string;
beforeAll(async () => {
  app = await startApp();
  files = await mkdtemp(join(tmpdir(), 'eztest-files-'));
  await writeFile(join(files, 'po.pdf'), '%PDF-1.4 purchase order');
  await writeFile(join(files, 'notes.txt'), 'hello');
}, 120_000);
afterAll(async () => {
  await app?.close();
});

describe('rich-text editors', () => {
  it.each([
    ['Comments', 'contenteditable'],
    ['Notes', 'quill'],
    ['Summary', 'ckeditor5'],
    ['Description', 'tinymce'],
  ])('the %s editor (%s)', { timeout: 120_000 }, async (name, adapter) => {
    const r = await expectPasses(app.url, `
Journey: ${name} editor
Open /editors
Type "Hello" in the ${name} editor [id=type]
Append ", world" to the ${name} editor
Expect the ${name} editor to contain "Hello, world"
Expect the ${name} editor to be "Hello, world"
Clear the ${name} editor
Expect the ${name} editor to be empty
Type "\${greeting}" in the ${name} editor
Expect the ${name} editor to contain "Hi there"
`, { variables: { greeting: 'Hi there' } });
    const ev = await componentEvidence(r, 'type');
    expect(ev.adapter).toBe(adapter);
    if (adapter === 'tinymce') expect(ev.verified).toMatch(/inside its iframe/);
  });
});

describe('sliders, masked inputs and drop zones', () => {
  it('sets real noUiSlider handles (single and range), a WAI-ARIA slider and the real MUI Slider', async () => {
    const r = await expectPasses(app.url, `
Journey: Sliders
Open /widgets
Set the Price slider to 40 [id=nouislider]
Expect the Price slider to be 40
Set the Price range slider to 30 and 70 [id=range]
Expect the Price range slider to be 70
Set the Discount slider to 35 [id=aria]
Open /mui
Set the Price slider to 25 [id=mui]
`);
    expect((await componentEvidence(r, 'nouislider')).adapter).toBe('nouislider');
    expect((await componentEvidence(r, 'aria')).adapter).toBe('aria-slider');
    expect((await componentEvidence(r, 'mui')).adapter).toBe('mui-slider');
    expect(stepById(r.j, 'range').status).toBe('passed');
  }, 120_000);

  it('types into real IMask inputs keystroke by keystroke', async () => {
    const r = await expectPasses(app.url, `
Journey: Masks
Open /widgets
Type "4111111111111111" into the Card number masked input [id=card]
Expect the value of the "Card number" field is "4111 1111 1111 1111"
Type "5551234567" into the Phone masked input
`);
    expect((await componentEvidence(r, 'card')).verified).toMatch(/4111 1111 1111 1111/);
  }, 120_000);

  it('drops files onto a pure drag-and-drop zone and a Dropzone.js zone (hidden input)', async () => {
    const r = await expectPasses(app.url, `
Journey: Drop zones
Open /widgets
Drop "po.pdf" onto the Attachments drop zone [id=generic]
Upload "po.pdf" and "notes.txt" to the Uploads drop zone [id=dz]
`, { baseDir: files });
    expect((await componentEvidence(r, 'generic')).verified).toMatch(/via a drop event/);
    expect((await componentEvidence(r, 'dz')).verified).toMatch(/via its file input/);
  }, 120_000);
});

describe('canvas charts', () => {
  it('counts points through Chart.js, ECharts, a Highcharts global and an accessible data table', async () => {
    const r = await expectPasses(app.url, `
Journey: Charts
Open /charts
Expect the chart Revenue to have 12 points [id=chartjs]
Expect the Revenue chart series "2025" to have 12 points
Expect the Revenue chart value for "Mar" to be 101
Expect the Orders by region chart to have 4 points [id=echarts]
Expect the Profit chart to have 12 points [id=highcharts]
Expect the Orders per month chart to have 6 points [id=table]
Capture the Orders of the row where Month is "Mar" in the Orders per month table as marchOrders [id=native-table]
Expect \${marchOrders} equals "101"
Capture the data of the Revenue chart as revenue [id=capture]
`);
    expect((await componentEvidence(r, 'chartjs')).adapter).toBe('chart.js');
    expect((await componentEvidence(r, 'echarts')).adapter).toBe('echarts');
    expect((await componentEvidence(r, 'highcharts')).adapter).toBe('highcharts');
    expect((await componentEvidence(r, 'table')).adapter).toBe('table');
    expect((await componentEvidence(r, 'native-table')).adapter).toBe('aria-grid');
    const data = stepById(r.j, 'capture').captured?.revenue as { labels: string[]; series: Array<{ name: string; values: number[] }> };
    expect(data.labels).toHaveLength(12);
    expect(data.series.map((s) => s.name)).toEqual(['2026', '2025']);
  }, 120_000);

  it('says plainly when a canvas chart cannot be inspected', async () => {
    const r = await runEz(app.url, 'Journey: J\nOpen /charts\nExpect the Traffic chart to have 3 points');
    expect(r.j.steps[1].error?.message).toMatch(/canvas chart is not inspectable: no Chart\.js, ECharts or Highcharts instance is reachable from the page, and the chart has no accessible data table/);
  }, 60_000);
});

describe('infinite lists', () => {
  it('scrolls an infinite feed until it stops growing, within a bound', async () => {
    const r = await expectPasses(app.url, `
Journey: Feed
Open /list
Expect the News feed to have 250 items in total [id=count]
Capture all items of the News feed up to 100 as first100 [id=capture]
Scroll inside role=feed[name="News"] until the "Item 240" text is visible
`);
    expect((stepById(r.j, 'capture').captured?.first100 as string[]).length).toBeGreaterThanOrEqual(100);
    expect((await componentEvidence(r, 'count')).verified).toMatch(/loaded 250 items/);
  }, 120_000);
});
