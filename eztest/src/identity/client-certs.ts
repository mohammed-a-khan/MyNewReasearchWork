/**
 * Resolve config `api.clientCertificates` for the runner: read the PFX / PEM
 * files (relative to the project) and resolve passphrases given as secret://
 * references (ENC(...) values are already decrypted when config loads). The
 * passphrase is registered with the masker.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { EzTestError } from '../core/index.js';
import type { ClientCertificateConfig } from '../config/index.js';
import type { SecretRegistry } from './handle.js';
import { isSecretRef } from './handle.js';

export interface ResolvedClientCertificate {
  name?: string;
  origin: string;
  pfx?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  passphrase?: string;
  ca?: Buffer;
  browser: boolean;
}

export async function resolveClientCertificates(list: ClientCertificateConfig[], o: { cwd?: string; registry: SecretRegistry }): Promise<ResolvedClientCertificate[]> {
  const cwd = o.cwd ?? process.cwd();
  const read = async (p: string, what: string, i: number) => {
    const file = isAbsolute(p) ? p : resolve(cwd, p);
    try {
      return await readFile(file);
    } catch {
      throw new EzTestError(`api.clientCertificates[${i}]: ${what} file not found: ${file}`, 'CLIENT_CERT_MISSING');
    }
  };
  const names = new Set<string>();
  const out: ResolvedClientCertificate[] = [];
  for (const [i, c] of list.entries()) {
    if (c.name) {
      if (names.has(c.name)) throw new EzTestError(`api.clientCertificates: duplicate name "${c.name}"`, 'CONFIG');
      names.add(c.name);
    }
    let passphrase = c.passphrase;
    if (passphrase !== undefined && isSecretRef(passphrase)) passphrase = await o.registry.resolve(passphrase);
    if (passphrase) o.registry.masker.add(passphrase);
    out.push({
      ...(c.name ? { name: c.name } : {}),
      origin: new URL(c.origin).origin,
      ...(c.pfx ? { pfx: await read(c.pfx, 'pfx', i) } : {}),
      ...(c.cert ? { cert: await read(c.cert, 'cert', i) } : {}),
      ...(c.key ? { key: await read(c.key, 'key', i) } : {}),
      ...(c.ca ? { ca: await read(c.ca, 'ca', i) } : {}),
      ...(passphrase !== undefined ? { passphrase } : {}),
      browser: c.browser,
    });
  }
  return out;
}
