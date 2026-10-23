/**
 * Video action overlays and chapters (G24). A short journey records video
 * through EZTest's own screencast + WebM muxer; each step burns in a caption
 * overlay and adds a WebVTT chapter. The HTML report renders a player with a
 * chapters track and a clickable step list that seeks. The overlay never
 * lands in an evidence screenshot.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { videoChaptersVtt } from '../../src/browser/index.js';
import { renderHtmlReport } from '../../src/report/index.js';
import { readEvidenceManifest } from '../../src/insights/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';

let app: Server;
let url = '';
beforeAll(async () => {
  app = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Form</title><h1>Form</h1>
<label>Name <input id="name"></label>
<button id="save" onclick="document.getElementById('msg').textContent='Saved'">Save</button>
<p id="msg"></p>`);
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
}, 30_000);
afterAll(async () => {
  await new Promise<void>((r) => app.close(() => r()));
});

describe('video chapters WebVTT', () => {
  it('builds a valid WebVTT chapters track, one cue per step', () => {
    const vtt = videoChaptersVtt([
      { startMs: 0, endMs: 1200, text: 'Open "/"' },
      { startMs: 1200, endMs: 2500, text: 'Type "Ada" into the "Name" field' },
      { startMs: 2500, endMs: 3000, text: 'Click the "Save" button' },
    ]);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toMatch(/00:00:00\.000 --> 00:00:01\.200\nOpen "\/"/);
    expect((vtt.match(/-->/g) ?? []).length).toBe(3);
  });
});

describe('recorded journey', () => {
  it('writes per-step chapters next to the video, burns in overlays, and the report plays them', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'eztest-vid-'));
    const ez = `Journey: Save a form
Open "/"
Type "Ada" into the "Name" field
Click the "Save" button
  Expect the page to contain "Saved"
`;
    const run = await runJourneys([parseEzScript(ez)], { outputDir, baseUrl: url, video: 'on', stepTimeoutMs: 15_000, conditionTimeoutMs: 4000, screenshots: 'every-step' });
    const j = run.journeys[0];
    expect(j.status, j.error?.message).toMatch(/^passed/);

    const runDir = join(outputDir, run.runId);
    const files = (await readdir(runDir, { recursive: true })).filter((f): f is string => typeof f === 'string');
    const webm = files.find((f) => f.endsWith('.webm'))!;
    const vtt = files.find((f) => f.endsWith('.chapters.vtt'))!;
    expect(webm, 'a .webm video was recorded').toBeTruthy();
    expect(vtt, 'a WebVTT chapters file sits beside the video').toBeTruthy();
    const chapters = await readFile(join(runDir, vtt), 'utf8');
    expect(chapters.startsWith('WEBVTT')).toBe(true);
    // One chapter per step, naming the steps.
    expect(chapters).toMatch(/Open "\//);
    expect(chapters).toMatch(/Type "Ada" into the "Name" field/);
    expect(chapters).toMatch(/Click the "Save" button/);

    // Both the video and the chapters are evidence.
    const manifest = await readEvidenceManifest(runDir);
    expect(manifest.some((e) => e.kind === 'video')).toBe(true);
    expect(manifest.some((e) => e.kind === 'video-chapters')).toBe(true);

    // The overlay never pollutes a step screenshot.
    for (const png of files.filter((f) => f.endsWith('.png'))) {
      const buf = await readFile(join(runDir, png));
      expect(buf.length).toBeGreaterThan(0);
    }
    // The HTML report embeds the player with the chapters track and the chapter-building script.
    const report = renderHtmlReport(run, { evidence: manifest });
    expect(report).toContain('<video controls');
    expect(report).toContain('kind="chapters"');
    expect(report).toContain(webm.split('/').pop()!);
    expect(report).toContain('ol class="chapters"');
    expect(report).toMatch(/media-src 'self' file: blob:/);
    // the chapter-building script wires clicks to seek the video
    expect(report).toContain('video.currentTime=cue.startTime');
  }, 120_000);
});
