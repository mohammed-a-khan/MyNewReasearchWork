/**
 * Wiring of the desktop and legacy ladder: one interceptor with every
 * driver's steps registered, built from the desktop:/mainframe:/citrix:
 * config blocks. The engine adds it to RunOptions.stepInterceptors.
 */
import { parseLegacyConfig, type LegacyConfig } from './config.js';
import { DESKTOP_HANDLERS, launchElectron } from './desktop-handlers.js';
import { DesktopInterceptor, type DesktopDeps } from './interceptor.js';
import { SAP_HANDLERS } from './sap-handlers.js';
import { visionHandlers, type VisionDeps } from './vision/handlers.js';

export interface DesktopIntegration {
  config: LegacyConfig;
  interceptor: DesktopInterceptor;
}

/** Build the interceptor from raw config blocks (validated here). */
export function createDesktopIntegration(raw: { desktop?: unknown; mainframe?: unknown; citrix?: unknown }, deps: DesktopDeps & { vision?: VisionDeps } = {}): DesktopIntegration {
  const config = parseLegacyConfig(raw);
  const interceptor = new DesktopInterceptor(config, deps);
  interceptor.register(DESKTOP_HANDLERS);
  interceptor.register(SAP_HANDLERS);
  interceptor.register(visionHandlers(deps.vision));
  // App: electron <main.js> launches the app before the journey's first step (that step then runs in it).
  interceptor.autoLaunch = async (step, ctx, rt, h) => {
    const e = ctx.journey.electron!;
    const r = await launchElectron({ ...step, id: `${step.id}-launch`, postconditions: [] }, ctx, rt, h, e.app, e.args ?? [], e.executable);
    return r.status === 'failed' ? { ...r, error: { message: r.error?.message ?? 'Electron launch failed' } } : undefined;
  };
  return { config, interceptor };
}
