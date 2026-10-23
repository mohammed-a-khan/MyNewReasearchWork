/**
 * Video files for `recordVideo`: screencast PNG frames are encoded to VP8 by
 * the browser being driven (WebCodecs `VideoEncoder`, in a scratch page of
 * the same browser - no external tool), and the encoded frames are written
 * into a WebM (Matroska) container by the muxer below.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface VideoFrame {
  png: Buffer;
  /** Seconds. */
  timestamp: number;
}

export interface EncodedFrame {
  /** Milliseconds from the start. */
  timeMs: number;
  key: boolean;
  data: Buffer;
}

/** Encodes frames to VP8 (provided by the browser). */
export type Vp8Encoder = (frames: VideoFrame[], size: { width: number; height: number }) => Promise<EncodedFrame[]>;

// ---------------------------------------------------------------------- EBML

function vintSize(n: number): Buffer {
  // Data size as an EBML variable-length integer (up to 8 bytes).
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const b = Buffer.alloc(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) {
        b[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      b[0] |= 1 << (8 - len);
      return b;
    }
  }
  throw new Error('EBML element too large');
}

function idBytes(id: number): Buffer {
  const hex = id.toString(16);
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
}

function el(id: number, payload: Buffer | Buffer[]): Buffer {
  const data = Array.isArray(payload) ? Buffer.concat(payload) : payload;
  return Buffer.concat([idBytes(id), vintSize(data.length), data]);
}

function uint(id: number, v: number): Buffer {
  let hex = Math.max(0, Math.floor(v)).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return el(id, Buffer.from(hex, 'hex'));
}

function str(id: number, s: string): Buffer {
  return el(id, Buffer.from(s, 'utf8'));
}

function float(id: number, v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return el(id, b);
}

/** Write encoded VP8 frames as a WebM file. */
export function muxWebM(frames: EncodedFrame[], size: { width: number; height: number }): Buffer {
  const header = el(0x1a45dfa3, [
    uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(0x4282, 'webm'), uint(0x4287, 2), uint(0x4285, 2),
  ]);
  const duration = frames.length ? frames[frames.length - 1].timeMs + 40 : 0;
  const info = el(0x1549a966, [uint(0x2ad7b1, 1_000_000), str(0x4d80, 'eztest'), str(0x5741, 'eztest'), float(0x4489, duration)]);
  const tracks = el(0x1654ae6b, [
    el(0xae, [uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1), str(0x86, 'V_VP8'), el(0xe0, [uint(0xb0, size.width), uint(0xba, size.height)])]),
  ]);
  const clusters: Buffer[] = [];
  let i = 0;
  while (i < frames.length) {
    const base = frames[i].timeMs;
    const blocks: Buffer[] = [uint(0xe7, base)];
    // A cluster spans at most ~30 s (block times are signed 16-bit offsets) and starts on a key frame.
    while (i < frames.length && frames[i].timeMs - base < 30_000 && (blocks.length === 1 || !frames[i].key || frames[i].timeMs - base < 5_000)) {
      const f = frames[i];
      const head = Buffer.alloc(4);
      head[0] = 0x81; // track 1
      head.writeInt16BE(Math.round(f.timeMs - base), 1);
      head[3] = f.key ? 0x80 : 0x00;
      blocks.push(el(0xa3, [head, f.data]));
      i++;
    }
    clusters.push(el(0x1f43b675, blocks));
  }
  const segment = el(0x18538067, [info, tracks, ...clusters]);
  return Buffer.concat([header, segment]);
}

/** Encode and write a WebM file. With no frames, a single blank frame is written. */
export async function encodeWebM(frames: VideoFrame[], size: { width: number; height: number }, file: string, encoder?: Vp8Encoder): Promise<void> {
  if (!encoder) throw new Error('No VP8 encoder available (the browser is gone)');
  const encoded = frames.length ? await encoder(frames, size) : [];
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, muxWebM(encoded, size));
}


// ---------------------------------------------------------------------- WebVTT chapters

export interface VideoChapter {
  startMs: number;
  endMs: number;
  text: string;
}

function vttTime(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const mmm = Math.round((s - Math.floor(s)) * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}.${p(mmm, 3)}`;
}

/** A WebVTT chapters track: one cue per step, so a player can list and seek to steps. */
export function videoChaptersVtt(chapters: VideoChapter[]): string {
  const lines = ['WEBVTT', ''];
  chapters.forEach((c, i) => {
    const end = Math.max(c.endMs, c.startMs + 200);
    lines.push(`${i + 1}`, `${vttTime(c.startMs)} --> ${vttTime(end)}`, c.text.replace(/\r?\n/g, ' ').trim() || `Step ${i + 1}`, '');
  });
  return lines.join('\n');
}
