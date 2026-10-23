/**
 * Page video recording (context option `recordVideo`): screencast frames
 * are collected while the page lives and encoded to a WebM file (VP8, our
 * own encoder in ../video/) when the page closes.
 */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { RecordVideoOptions } from '../types.js';
import { encodeWebM, videoChaptersVtt, type VideoChapter, type VideoFrame } from '../video/webm.js';
import { deferred } from '../util.js';
import type { CrPage } from './page.js';

export class Video {
  private readonly file: string;
  private readonly frames: VideoFrame[] = [];
  private stopScreencast?: () => Promise<void>;
  private readonly done = deferred<string>();
  private stopping = false;
  /** First frame's timestamp (seconds), the zero of chapter offsets. */
  private firstAt?: number;
  /** Step marks: when (seconds) and the step text, for WebVTT chapters. */
  private readonly marks: Array<{ at: number; text: string }> = [];

  constructor(private readonly page: CrPage, private readonly opts: RecordVideoOptions) {
    this.file = join(opts.dir, `${randomUUID().replace(/-/g, '')}.webm`);
  }

  async start(): Promise<void> {
    const vp = this.page.viewportSize() ?? { width: 800, height: 600 };
    const size = this.opts.size ?? scaleDown(vp, 800);
    this.stopScreencast = await this.page.startScreencast(
      { format: 'png', maxWidth: size.width, maxHeight: size.height },
      (f) => {
        if (this.stopping) return;
        if (this.firstAt === undefined) this.firstAt = f.timestamp;
        this.frames.push({ png: f.data, timestamp: f.timestamp });
        // Bound memory: keep at most ~10 minutes at 25 fps.
        if (this.frames.length > 15_000) this.frames.splice(0, this.frames.length - 15_000);
      },
    );
  }

  /** Mark the start of a step, so the video gets a WebVTT chapter for it. */
  markStep(text: string): void {
    if (this.stopping) return;
    this.marks.push({ at: Date.now() / 1000, text });
  }

  /** Path of the WebVTT chapters file written next to the video. */
  get chaptersFile(): string {
    return this.file.replace(/\.webm$/, '.chapters.vtt');
  }

  /** Chapters as {startMs, endMs, text}, anchored to the first frame. */
  chapters(): VideoChapter[] {
    if (!this.marks.length) return [];
    const zero = this.firstAt ?? this.marks[0].at;
    const lastFrame = this.frames.length ? this.frames[this.frames.length - 1].timestamp : this.marks[this.marks.length - 1].at;
    const durationMs = Math.max(0, (lastFrame - zero) * 1000) + 500;
    return this.marks.map((m, i) => ({
      startMs: Math.max(0, Math.round((m.at - zero) * 1000)),
      endMs: Math.round(((i + 1 < this.marks.length ? this.marks[i + 1].at : zero + durationMs / 1000) - zero) * 1000),
      text: m.text,
    }));
  }

  /** Stop and encode (called when the page closes). */
  async stop(): Promise<void> {
    if (this.stopping) return;
    const chapters = this.chapters();
    this.stopping = true;
    try {
      await this.stopScreencast?.().catch(() => undefined);
      await mkdir(this.opts.dir, { recursive: true });
      const vp = this.page.viewportSize() ?? { width: 800, height: 600 };
      const size = this.opts.size ?? scaleDown(vp, 800);
      await encodeWebM(this.frames, size, this.file, this.page.context().browser().vp8Encoder());
      if (chapters.length) await writeFile(this.chaptersFile, videoChaptersVtt(chapters)).catch(() => undefined);
      this.frames.splice(0);
      this.done.resolve(this.file);
    } catch (e) {
      this.done.reject(e as Error);
    }
  }

  /** Path of the video file; resolves once the page is closed and the file written. */
  async path(): Promise<string> {
    return this.file;
  }

  async saveAs(path: string): Promise<void> {
    await copyFile(await this.done.promise, path);
  }

  async delete(): Promise<void> {
    await this.done.promise.catch(() => undefined);
    await rm(this.file, { force: true });
  }

  /** Internal: resolves when the file is complete. */
  finished(): Promise<string> {
    return this.done.promise;
  }
}

function scaleDown(vp: { width: number; height: number }, max: number): { width: number; height: number } {
  const s = Math.min(1, max / Math.max(vp.width, vp.height));
  const even = (n: number) => Math.max(2, Math.floor((n * s) / 2) * 2);
  return { width: even(vp.width), height: even(vp.height) };
}
