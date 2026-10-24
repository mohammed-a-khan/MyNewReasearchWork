/**
 * The `desktop:`, `mainframe:` and `citrix:` configuration blocks. The core
 * config schema accepts them as records; this module validates them. Secret
 * values (passwords, tokens) are `secret://store/key` references resolved
 * through the Identity Vault when a session starts, never at load time.
 */
import { z } from 'zod';

const SecretOrText = z.string().min(1);

export const WindowsAppSchema = z.object({
  /** Executable path or AUMID (UWP), e.g. C:\\Apps\\Invoice.exe or Microsoft.WindowsCalculator_8wekyb3d8bbwe!App. */
  app: z.string().min(1).optional(),
  args: z.string().optional(),
  workingDir: z.string().optional(),
  /** Attach to an already running top-level window with this title instead of launching. */
  window: z.string().optional(),
});

export const WindowsSchema = z.object({
  /** URL of EZTest's Windows agent (agents/windows) on the machine that runs the app. */
  url: z.string().url().default('http://127.0.0.1:47123'),
  /** The agent's token (secret://...). */
  token: SecretOrText.optional(),
  apps: z.record(z.string(), WindowsAppSchema).default({}),
  timeoutMs: z.number().int().positive().default(30_000),
});

export const JavaAppSchema = z.object({
  /** Command that starts the app, e.g. ["java", "-jar", "ledger.jar"]; EZTest adds its -javaagent option. */
  command: z.array(z.string().min(1)).min(1).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  /** Attach to a JVM already started with the agent (its URL) instead of launching. */
  url: z.string().url().optional(),
});

export const JavaSchema = z.object({
  /** The agent jar (default: EZTest compiles the shipped agent sources with javac on first use; agents/java/build.sh in a clone of the repository builds one). */
  agentJar: z.string().optional(),
  token: SecretOrText.optional(),
  apps: z.record(z.string(), JavaAppSchema).default({}),
  startTimeoutMs: z.number().int().positive().default(30_000),
  timeoutMs: z.number().int().positive().default(30_000),
});

export const SapSystemSchema = z.object({
  /** SAP Logon connection description (as in SAP Logon), e.g. "ERP Development". */
  connection: z.string().min(1),
  client: z.string().optional(),
  user: z.string().optional(),
  /** secret://... */
  password: SecretOrText.optional(),
  language: z.string().optional(),
});

export const SapSchema = z.object({
  /** URL of the Windows-side SAP GUI Scripting bridge (docs/sap-gui-bridge.ps1). */
  bridge: z.string().url().default('http://127.0.0.1:8765'),
  /** Shared token the bridge requires (secret://...). */
  token: SecretOrText.optional(),
  systems: z.record(z.string(), SapSystemSchema).default({}),
  timeoutMs: z.number().int().positive().default(60_000),
});

export const ElectronSchema = z.object({
  /** Electron binary; default: the `electron` package of the project. */
  executablePath: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().default(30_000),
});

export const DesktopConfigSchema = z.object({
  windows: WindowsSchema.optional(),
  java: JavaSchema.optional(),
  sap: SapSchema.optional(),
  electron: ElectronSchema.prefault({}),
});

export const MainframeHostSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  tls: z.boolean().default(false),
  /** PEM file with extra CAs to trust for TLS (relative to the project). */
  caFile: z.string().optional(),
  model: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).default(2),
  terminalType: z.string().optional(),
  /** tn3270 (IBM Z, default) or tn5250 (IBM i). */
  protocol: z.enum(['tn3270', 'tn5250']).default('tn3270'),
  /** TN5250: 27x132 display (IBM-3477-FC) instead of 24x80 (IBM-3179-2). */
  wide: z.boolean().default(false),
  /** TN5250: virtual device name to request (NEW-ENVIRON DEVNAME), e.g. EZTEST01. */
  deviceName: z.string().regex(/^[A-Za-z0-9_$#@]{1,10}$/).optional(),
  timeoutMs: z.number().int().positive().default(15_000),
  settleMs: z.number().int().min(0).default(150),
  /** Sign-on screen labels (defaults: USERID / PASSWORD on TN3270, User / Password on TN5250) and the key that submits it. */
  logon: z.object({ userField: z.string().optional(), passwordField: z.string().optional(), key: z.string().optional() }).prefault({}),
  users: z.record(z.string(), z.object({ user: z.string().min(1), password: SecretOrText })).default({}),
});

export const MainframeConfigSchema = z.object({
  hosts: z.record(z.string(), MainframeHostSchema).default({}),
});

export const VncSessionSchema = z.object({
  /** VNC/RFB endpoint of the Citrix/VDI or remote desktop, "host:port" (default port 5900). */
  vnc: z.string().min(1),
  /** VNC password (secret://...). */
  password: SecretOrText.optional(),
  timeoutMs: z.number().int().positive().default(15_000),
});

export const CitrixConfigSchema = z.object({
  sessions: z.record(z.string(), VncSessionSchema).default({}),
  /** Directory image templates resolve against (default: the project directory). */
  images: z.string().optional(),
  match: z.object({
    /** Normalised cross-correlation needed for an image match (0..1). */
    threshold: z.number().min(0.5).max(1).default(0.9),
    /** Scales tried for DPI differences (1 = 100%). */
    scales: z.array(z.number().min(0.25).max(4)).default([1, 1.25, 1.5, 0.8, 2]),
  }).prefault({}),
  ocr: z.object({
    lang: z.string().default('eng'),
    /** Directory with <lang>.traineddata(.gz); default: the @tesseract.js-data/<lang> package if installed. */
    langPath: z.string().optional(),
    /** Minimum word confidence (0..100). */
    minConfidence: z.number().min(0).max(100).default(60),
  }).prefault({}),
  /** How long "Wait for the text ... on screen" polls by default. */
  waitMs: z.number().int().positive().default(15_000),
});

export type DesktopConfig = z.infer<typeof DesktopConfigSchema>;
export type MainframeConfig = z.infer<typeof MainframeConfigSchema>;
export type CitrixConfig = z.infer<typeof CitrixConfigSchema>;
export type MainframeHost = z.infer<typeof MainframeHostSchema>;

export interface LegacyConfig {
  desktop: DesktopConfig;
  mainframe: MainframeConfig;
  citrix: CitrixConfig;
}

/** Validate the three blocks (each optional). Errors name the block. */
export function parseLegacyConfig(raw: { desktop?: unknown; mainframe?: unknown; citrix?: unknown }): LegacyConfig {
  const one = <T>(name: string, schema: z.ZodType<T>, v: unknown): T => {
    const r = schema.safeParse(v ?? {});
    if (!r.success) throw new Error(`Invalid ${name}: config: ${r.error.issues.map((i) => `${i.path.join('.') || name}: ${i.message}`).join('; ')}`);
    return r.data;
  };
  return {
    desktop: one('desktop', DesktopConfigSchema, raw.desktop),
    mainframe: one('mainframe', MainframeConfigSchema, raw.mainframe),
    citrix: one('citrix', CitrixConfigSchema, raw.citrix),
  };
}
