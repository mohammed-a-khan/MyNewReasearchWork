/**
 * The `mobile:` config block (validated here, like the d365/salesforce
 * add-ons) and the driver built from it.
 */
import { z } from 'zod';
import { EzTestError } from '../core/index.js';
import { createMobileDriver, type MobileDriver, type MobileDriverOptions } from './driver.js';

export const MobileConfigSchema = z.object({
  /** Default platform for journeys without a Platform: header (web journeys stay web unless this is set). */
  platform: z.enum(['web', 'android', 'ios']).optional(),
  /** Default app: an installed package / bundle id, or an .apk / .app / .ipa to install. */
  app: z.string().min(1).optional(),
  android: z.object({
    adb: z.object({ host: z.string().min(1).default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(5037) }).prefault({}),
    /** Serials of the devices to use (a pool for concurrent journeys). */
    devices: z.array(z.string().min(1)).default([]),
    agentApk: z.string().min(1).optional(),
    agentPort: z.number().int().min(1).max(65535).default(6790),
    agentUrl: z.string().url().optional(),
    /** Session token of an agent started by hand (with agentUrl); agents EZTest starts get a random one. */
    agentToken: z.string().min(16).optional(),
    clearData: z.boolean().default(false),
  }).strict().prefault({}),
  ios: z.object({
    devices: z.array(z.string().min(1)).default([]),
    simulator: z.boolean().optional(),
    agentUrl: z.string().url().optional(),
    agentPort: z.number().int().min(1).max(65535).default(8790),
    /** Session token of an agent started by hand; an agent EZTest starts (xctestrun) gets a random one. */
    agentToken: z.string().min(16).optional(),
    xctestrun: z.string().min(1).optional(),
    usbmux: z.object({ path: z.string().optional(), host: z.string().optional(), port: z.number().int().optional() }).optional(),
  }).strict().prefault({}),
  screenshots: z.enum(['every-step', 'on-failure', 'off', 'before-assertions']).optional(),
  pageSource: z.enum(['every-step', 'on-failure', 'off']).default('on-failure'),
  /** Device logs to keep per journey attempt: logcat (Android), syslog (iOS simulator). */
  logs: z.array(z.string().min(1)).default([]),
  webviewTimeoutMs: z.number().int().positive().default(10_000),
  agentTimeoutMs: z.number().int().positive().default(30_000),
}).strict();

export type MobileConfig = z.infer<typeof MobileConfigSchema>;
export type MobileConfigInput = z.input<typeof MobileConfigSchema>;

export interface MobileDriverDeps {
  mask?: (s: string) => string;
  baseDir?: string;
}

/** Validate a `mobile:` block. */
export function parseMobileConfig(raw: unknown): MobileConfig {
  const r = MobileConfigSchema.safeParse(raw ?? {});
  if (!r.success) throw new EzTestError(`mobile: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`, 'CONFIG');
  return r.data;
}

export function driverOptionsFromConfig(cfg: MobileConfig, deps: MobileDriverDeps = {}): MobileDriverOptions {
  return {
    ...(cfg.app ? { app: cfg.app } : {}),
    android: { ...cfg.android },
    ios: { ...cfg.ios },
    ...(cfg.screenshots ? { screenshots: cfg.screenshots } : {}),
    pageSource: cfg.pageSource, logs: cfg.logs, webviewTimeoutMs: cfg.webviewTimeoutMs, agentTimeoutMs: cfg.agentTimeoutMs,
    ...(deps.baseDir ? { baseDir: deps.baseDir } : {}), ...(deps.mask ? { mask: deps.mask } : {}),
  };
}

/** Runner options for a `mobile:` block: the mobile driver and the default platform. */
export function mobileRunOptions(raw: unknown, deps: MobileDriverDeps = {}): { platformDrivers: MobileDriver[]; platform?: 'web' | 'android' | 'ios' } {
  const cfg = parseMobileConfig(raw);
  return { platformDrivers: [createMobileDriver(driverOptionsFromConfig(cfg, deps))], ...(cfg.platform ? { platform: cfg.platform } : {}) };
}
