/**
 * Unique test data that cannot collide across parallel workers, processes,
 * CI shards and machines: every value combines a time component, a token for
 * this process (host, pid, CI shard and random bits) and a per-process counter.
 *
 *   unique("ORD-")          ORD-m2x9k1-7f3a-4      (time, process token, counter; base 36)
 *   uniqueEmail()           t-m2x9k1-7f3a-5@example.test
 */
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

let counter = 0;
let token: string | undefined;

/** CI shard / node index when the environment names one. */
export function shardIndex(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.EZTEST_SHARD ?? env.CI_NODE_INDEX ?? env.BUILDKITE_PARALLEL_JOB ?? env.SYSTEM_JOBPOSITIONINPHASE ?? env.CIRCLE_NODE_INDEX ?? undefined;
}

/** A short token for this process: hash of host + pid + shard + random bits (4 base-36 chars). */
export function processToken(): string {
  if (!token) {
    const h = createHash('sha256').update(`${hostname()}\0${process.pid}\0${shardIndex() ?? ''}\0${randomBytes(8).toString('hex')}`).digest();
    token = (h.readUInt32BE(0) % 36 ** 4).toString(36).padStart(4, '0');
  }
  return token;
}

/** A value unique across workers, shards and runs. `maxLength` trims the time part first (never the token or counter). */
export function uniqueValue(prefix = '', maxLength?: number): string {
  const n = (++counter).toString(36);
  const shard = shardIndex();
  const time = Date.now().toString(36);
  const tail = `${processToken()}${shard ? `${shard}` : ''}-${n}`;
  let v = `${prefix}${time}-${tail}`;
  if (maxLength !== undefined && v.length > maxLength) {
    const room = Math.max(0, maxLength - prefix.length - tail.length - 1);
    v = `${prefix}${time.slice(-room)}${room ? '-' : ''}${tail}`;
    if (v.length > maxLength) throw new Error(`uniqueValue: maxLength ${maxLength} is too short for a collision-free value (needs ${prefix.length + tail.length})`);
  }
  return v;
}

export function uniqueEmail(domain = 'example.test', prefix = 't-'): string {
  return `${uniqueValue(prefix)}@${domain}`.toLowerCase();
}
