/**
 * TLS settings of a broker (Kafka, AMQP, MQTT, a schema registry) as Node
 * tls options: certificate files are read relative to the project, PEM text
 * is taken as is. Server certificates are always verified (Node's default);
 * `ca` only adds trusted roots.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ConnectionOptions } from 'node:tls';
import { EzTestError } from '../core/index.js';
import type { BrokerTls } from './config.js';

export type TlsOptions = Pick<ConnectionOptions, 'ca' | 'cert' | 'key' | 'pfx' | 'passphrase' | 'servername'>;

function material(v: string, baseDir: string, what: string): Buffer {
  if (/-----BEGIN [A-Z ]+-----/.test(v)) return Buffer.from(v);
  const p = isAbsolute(v) ? v : resolve(baseDir, v);
  try {
    return readFileSync(p);
  } catch (e) {
    throw new EzTestError(`Cannot read the TLS ${what} file ${p}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, 'TLS_CONFIG');
  }
}

/** Node tls options for broker TLS settings (undefined when there are none). */
export function loadTls(t: BrokerTls | undefined, baseDir: string): TlsOptions | undefined {
  if (!t) return undefined;
  const out: TlsOptions = {};
  if (t.ca) out.ca = (Array.isArray(t.ca) ? t.ca : [t.ca]).map((c) => material(c, baseDir, 'CA'));
  if (t.cert) out.cert = material(t.cert, baseDir, 'client certificate');
  if (t.key) out.key = material(t.key, baseDir, 'client key');
  if (t.pfx) out.pfx = material(t.pfx, baseDir, 'PKCS#12');
  if (t.passphrase !== undefined) out.passphrase = t.passphrase;
  if (t.servername) out.servername = t.servername;
  return out;
}
