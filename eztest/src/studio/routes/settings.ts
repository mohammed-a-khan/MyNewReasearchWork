/** Settings: the effective configuration (secrets masked) and a doctor check. */
import type { SecretMasker } from '../../config/index.js';
import { sendJson } from '../http.js';
import { relPosix } from '../security.js';
import type { StudioRoute } from './route.js';

const SECRET_KEY = /pass(?:word)?|secret|token|api[-_]?key|private|credential|^pat$|connectionstring/i;

export function maskConfig(value: unknown, masker: SecretMasker): unknown {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key && SECRET_KEY.test(key) && !/^secret:\/\//.test(v) && v.length) return '****';
      return masker.mask(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value);
}

let doctorCache: { chromium: string } | undefined;
async function browserCheck(): Promise<{ chromium: string }> {
  if (doctorCache) return doctorCache;
  try {
    const { chromium } = await import('../../browser/index.js');
    const b = await chromium.launch();
    doctorCache = { chromium: `ok (${b.version()})` };
    await b.close();
  } catch (e) {
    doctorCache = { chromium: `not available: ${(e as Error).message.split('\n')[0]}` };
  }
  return doctorCache;
}

export const settingsRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/settings',
    summary: 'Effective configuration (masked), config layers, warnings and doctor',
    async handler({ res, app }) {
      const major = Number(process.versions.node.split('.')[0]);
      const doctor: Record<string, string> = {
        node: `${process.versions.node} ${major >= 20 ? 'ok' : '(needs 20 or newer)'}`,
        platform: `${process.platform} ${process.arch}`,
        ...(await browserCheck()),
      };
      try {
        const loaded = await app.config();
        sendJson(res, 200, {
          ok: true,
          config: maskConfig(loaded.config, loaded.masker),
          sources: loaded.sources.map((s) => (s.startsWith(app.cwd) ? relPosix(app.cwd, s) : s)),
          warnings: loaded.warnings.map((w) => loaded.masker.mask(w)),
          env: loaded.env,
          doctor,
        });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: (e as Error).message, warnings: [], doctor });
      }
    },
  },
];
