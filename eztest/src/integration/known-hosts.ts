/**
 * Strict SSH host-key checking against an OpenSSH-format known_hosts file
 * (default `<project>/.eztest/known_hosts`).
 *
 * - A host whose key is listed is accepted only with that key; a different
 *   key of the same type fails (the host key changed, or someone is in the
 *   middle).
 * - An unknown host fails, unless the server config says
 *   `trustOnFirstUse: true`: then its key is added to the file and later
 *   connections are checked against it.
 * - `hostKeySha256` pins the key fingerprint instead (no file needed).
 *
 * Lines are `host[,host...] keytype base64key [comment]`, hosts as `name`
 * (port 22) or `[name]:port`, or hashed (`|1|salt|hash`, HMAC-SHA1 of the
 * host). Wildcards and markers (@cert-authority, @revoked) are not used for
 * matching; a @revoked key is refused.
 */
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface HostKeyCheck {
  ok: boolean;
  /** Why the key was refused (unknown host, changed key), with what to do. */
  reason?: string;
  /** The key was added to the file (trust on first use). */
  added?: boolean;
}

/** The host as known_hosts names it: `name` for port 22, `[name]:port` otherwise. */
export function knownHostName(host: string, port = 22): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** The key type inside an SSH wire-format public key (e.g. ssh-ed25519). */
export function keyTypeOf(key: Buffer): string {
  if (key.length < 4) return 'unknown';
  const n = key.readUInt32BE(0);
  return key.subarray(4, 4 + n).toString('ascii');
}

/** SHA-256 fingerprint as OpenSSH prints it ("SHA256:..." without padding). */
export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function hostMatches(pattern: string, name: string): boolean {
  if (pattern.startsWith('|1|')) {
    const [, , salt, hash] = pattern.split('|');
    if (!salt || !hash) return false;
    return createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64') === hash;
  }
  return pattern === name;
}

interface Entry {
  marker?: string;
  hosts: string[];
  type: string;
  key: string;
}

function parse(text: string): Entry[] {
  const out: Entry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const marker = parts[0].startsWith('@') ? parts.shift() : undefined;
    if (parts.length < 3) continue;
    out.push({ ...(marker ? { marker } : {}), hosts: parts[0].split(','), type: parts[1], key: parts[2] });
  }
  return out;
}

/** Check (and, with trustOnFirstUse, record) the key a server presented. */
export function checkHostKey(file: string, host: string, port: number, key: Buffer, o: { trustOnFirstUse?: boolean; label?: string } = {}): HostKeyCheck {
  const name = knownHostName(host, port);
  const type = keyTypeOf(key);
  const b64 = key.toString('base64');
  const fp = fingerprintOf(key);
  const label = o.label ? `${o.label} (${name})` : name;
  const entries = existsSync(file) ? parse(readFileSync(file, 'utf8')).filter((e) => e.hosts.some((h) => hostMatches(h, name))) : [];
  if (entries.some((e) => e.marker === '@revoked' && e.key === b64)) return { ok: false, reason: `The host key of ${label} (${fp}) is marked @revoked in ${file}` };
  const plain = entries.filter((e) => !e.marker);
  if (plain.some((e) => e.type === type && e.key === b64)) return { ok: true };
  if (plain.length) {
    const same = plain.find((e) => e.type === type);
    return {
      ok: false,
      reason: same
        ? `The host key of ${label} changed: it presented ${type} ${fp}, but ${file} has another ${type} key for it. Someone may be intercepting the connection; if the server was really re-keyed, remove the old line from ${file}.`
        : `${label} presented a ${type} key (${fp}), but ${file} only lists ${[...new Set(plain.map((e) => e.type))].join(', ')} key(s) for it; add the new key to ${file} if it is genuine.`,
    };
  }
  if (!o.trustOnFirstUse) {
    return {
      ok: false,
      reason: `The host key of ${label} is not known (${type} ${fp}). Add it to ${file} (for example: ssh-keyscan ${port === 22 ? '' : `-p ${port} `}${host} >> ${file}), pin it with hostKeySha256, or set trustOnFirstUse: true to record it on the first connection.`,
    };
  }
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${name} ${type} ${b64}\n`);
  return { ok: true, added: true };
}
