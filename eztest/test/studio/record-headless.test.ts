/**
 * Recording without a display: `eztest studio --record-headless` records with a
 * headless browser, and without it the Studio says why a visible browser cannot
 * open (no DISPLAY / WAYLAND_DISPLAY) and what to do.
 */
import { describe, expect, it } from '../support/testkit.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildProgram } from '../../src/cli/program.js';
import { RecordManager, noDisplayHint } from '../../src/studio/record.js';

describe('recording without a display', () => {
  it('noDisplayHint: only on X11/Wayland systems without DISPLAY and WAYLAND_DISPLAY', () => {
    expect(noDisplayHint({}, 'linux')).toMatch(/No display found .*eztest studio --record-headless/);
    expect(noDisplayHint({ DISPLAY: ':0' }, 'linux')).toBeUndefined();
    expect(noDisplayHint({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBeUndefined();
    expect(noDisplayHint({}, 'darwin')).toBeUndefined();
    expect(noDisplayHint({}, 'win32')).toBeUndefined();
  });

  it('eztest studio has --record-headless', () => {
    const studio = buildProgram().commands.find((c) => c.name() === 'studio')!;
    expect(studio.options.map((o) => o.long)).toContain('--record-headless');
  });

  it('headless recording works without a display; a headed start without one fails with the hint', async () => {
    const site = createServer((_q, r) => r.end('<!doctype html><html lang="en"><title>x</title><main><button>Go</button></main></html>'));
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    try {
      const headless = new RecordManager({ headless: true, env: {} });
      const s = await headless.start({ url });
      expect(s.state).toBe('recording');
      await headless.stop();
      if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        const headed = new RecordManager({ env: {} });
        await expect(headed.start({ url })).rejects.toThrow(/Could not start recording: .*No display found .*--record-headless/);
      }
    } finally {
      site.close();
    }
  }, 60_000);
});
