/**
 * Image and OCR steps. A screen is chosen with `Connect to Citrix "desk1"`
 * (VNC), `Use the browser page as the screen` (canvas apps),
 * `Use the desktop app window as the screen` or `Use the screen image "x.png"`.
 * Without one, image/OCR steps use the browser page.
 */
import { join } from 'node:path';
import { EzTestError } from '../../core/index.js';
import { AgentSurface } from '../agent-surface.js';
import { ElectronSurface } from '../electron.js';
import { failedStep, onSurface, type DesktopHandler, type HandlerEnv } from '../interceptor.js';
import type { StepContext } from '../../runner/types.js';
import { TesseractOcr, type OcrEngine } from './ocr.js';
import { agentSource, browserSource, electronSource, imageSource, vncSource, type BrowserPageLike } from './sources.js';
import { VisionSurface, type ScreenSource } from './surface.js';

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new EzTestError(`missing ${what}`, 'MISSING_VALUE');
  return v;
};

/** Override the OCR engine (tests, or a custom engine). */
export interface VisionDeps {
  ocr?: () => OcrEngine;
}

function makeSurface(h: HandlerEnv, source: ScreenSource, deps: VisionDeps): VisionSurface {
  const c = h.config.citrix;
  const base = h.deps.baseDir ?? process.cwd();
  const ocr = deps.ocr ? deps.ocr() : new TesseractOcr({ lang: c.ocr.lang, ...(c.ocr.langPath ? { langPath: h.path(c.ocr.langPath) } : {}), baseDir: base, cachePath: join(base, '.eztest', 'ocr') });
  return new VisionSurface(source, ocr, { imagesDir: c.images ? h.path(c.images) : base, threshold: c.match.threshold, scales: c.match.scales, minConfidence: c.ocr.minConfidence, waitMs: c.waitMs });
}

/** The active vision surface, or one over the browser page. */
function vision(h: HandlerEnv, ctx: StepContext, deps: VisionDeps): VisionSurface {
  const a = h.session.active;
  if (a?.kind === 'vision') return a as unknown as VisionSurface;
  const existing = h.session.surfaces.get('vision:browser');
  if (existing) return existing as unknown as VisionSurface;
  const s = makeSurface(h, browserSource(() => ctx.page as unknown as BrowserPageLike), deps);
  h.session.surfaces.set('vision:browser', s);
  return s;
}

export function visionHandlers(deps: VisionDeps = {}): Record<string, DesktopHandler> {
  return {
    'vision.use': async (step, ctx, rt, h) => {
      const kind = str(h.args.source, 'screen source');
      let source: ScreenSource;
      let key: string;
      try {
        if (kind === 'browser') {
          source = browserSource(() => ctx.page as unknown as BrowserPageLike);
          key = 'vision:browser';
        } else if (kind === 'image') {
          const p = h.path(str(h.args.image, 'image'));
          source = imageSource(p);
          key = `vision:image:${p}`;
        } else if (kind === 'citrix') {
          const name = str(h.args.name, 'session name');
          const def = h.config.citrix.sessions[name];
          const target = def?.vnc ?? name;
          const m = /^([\w.-]+)(?::(\d+))?$/.exec(target);
          if (!m) throw new EzTestError(`Unknown Citrix/VNC session "${name}": add it under citrix.sessions (vnc: host:port)`, 'UNKNOWN_SESSION');
          source = await vncSource(name, { host: m[1], ...(m[2] ? { port: Number(m[2]) } : {}), ...(def?.password ? { password: await h.secret(def.password) } : {}), timeoutMs: def?.timeoutMs });
          key = `vision:citrix:${name}`;
        } else {
          const app = [...h.session.surfaces.values()].find((s) => s.kind === 'windows' || s.kind === 'java' || s.kind === 'electron');
          if (!app) throw new EzTestError('no desktop app is open to use as the screen', 'NO_SURFACE');
          source = app instanceof ElectronSurface ? electronSource(app) : agentSource(app.label, (app as AgentSurface).client);
          key = `vision:desktop:${app.label}`;
        }
      } catch (e) {
        return failedStep(`could not open the screen: ${(e as Error).message}`);
      }
      const s = makeSurface(h, source, deps);
      h.open(key, s);
      return onSurface(s, step, ctx, rt, async () => {
        await s.shot();
        return { surface: { driver: 'vision', rung: 'coordinates', via: `screen ${source.name}` }, newScreen: true };
      });
    },
    'vision.clickImage': async (step, ctx, rt, h) => {
      const s = vision(h, ctx, deps);
      const image = str(h.args.image, 'image');
      return onSurface(s, step, ctx, rt, async () => {
        const m = await s.locateImage(image, Math.min(s.o.waitMs, step.timeoutMs ?? 5000));
        await s.clickAt(m.x + m.width / 2, m.y + m.height / 2, { ...(h.args.double ? { double: true } : {}), ...(h.args.button ? { button: h.args.button as 'right' } : {}) });
        return s.imageResult(m, image, { newScreen: true });
      });
    },
    'vision.clickText': async (step, ctx, rt, h) => {
      const s = vision(h, ctx, deps);
      const text = str(h.args.text, 'text');
      return onSurface(s, step, ctx, rt, async () => {
        const t = await s.locateText(text, Math.min(s.o.waitMs, step.timeoutMs ?? 5000));
        await s.clickAt(t.box.x + t.box.width / 2, t.box.y + t.box.height / 2, { ...(h.args.double ? { double: true } : {}), ...(h.args.button ? { button: h.args.button as 'right' } : {}) });
        return s.textResult(t, `text "${text}"`, { newScreen: true });
      });
    },
    'vision.clickAt': async (step, ctx, rt, h) => {
      const s = vision(h, ctx, deps);
      const x = Number(h.args.x);
      const y = Number(h.args.y);
      return onSurface(s, step, ctx, rt, async () => {
        await s.shot();
        await s.clickAt(x, y, { ...(h.args.double ? { double: true } : {}), ...(h.args.button ? { button: h.args.button as 'right' } : {}) });
        return { surface: { driver: 'vision', rung: 'coordinates', via: `${x},${y}`, box: { x, y, width: 1, height: 1 } }, newScreen: true };
      });
    },
    'vision.read': async (step, ctx, rt, h) => {
      const s = vision(h, ctx, deps);
      const as = str(h.args.as, 'variable name');
      const region = h.args.width !== undefined ? { x: Number(h.args.x), y: Number(h.args.y), width: Number(h.args.width), height: Number(h.args.height) } : undefined;
      return onSurface(s, step, ctx, rt, async () => {
        const text = await s.read(region);
        return { surface: { driver: 'vision', rung: 'ocr', via: region ? `region ${region.x},${region.y},${region.width},${region.height}` : 'whole screen', ...(region ? { box: region } : {}) }, captured: { [as]: text } };
      });
    },
    'vision.expectImage': async (step, ctx, rt, h) => {
      const s = vision(h, ctx, deps);
      const image = str(h.args.image, 'image');
      return onSurface(s, step, ctx, rt, async () => {
        if (h.args.negate) {
          const deadline = Date.now() + rt.conditionTimeoutMs;
          for (;;) {
            try {
              const m = await s.locateImage(image);
              if (Date.now() >= deadline) throw new Error(`image "${image}" is on ${s.label} (score ${m.score})`);
            } catch (e) {
              if (/was not found/.test((e as Error).message)) return { surface: { driver: 'vision', rung: 'image', via: `image "${image}" absent` } };
              throw e;
            }
            await new Promise((r) => setTimeout(r, 300));
          }
        }
        return s.imageResult(await s.locateImage(image, rt.conditionTimeoutMs), image);
      });
    },
    'vision.waitImage': async (step, ctx, rt, h) => {
      const s = vision(h, ctx, deps);
      const image = str(h.args.image, 'image');
      return onSurface(s, step, ctx, rt, async () => s.imageResult(await s.locateImage(image, Number(h.args.timeoutMs ?? s.o.waitMs)), image, { newScreen: true }));
    },
    'vision.type': async (step, ctx, rt, h) => {
      const s = vision(h, ctx, deps);
      const text = String(h.args.text ?? '');
      return onSurface(s, step, ctx, rt, async () => {
        await s.source.type(text);
        return { surface: { driver: 'vision', rung: 'coordinates', via: 'keyboard' } };
      });
    },
  };
}
