/**
 * Shared team state between the results server and a project's local files:
 * `.eztest/heal-decisions.json`, `quarantine.json` and `triage-overrides.json`.
 *
 * The server is the source of truth; the local files are the working copy and
 * the fallback when the server is unreachable. A snapshot of what the server
 * returned last time (`.eztest/server-state/<kind>.base.json`) tells local
 * edits (Studio heal inbox, quarantine, triage) apart from server changes:
 *
 * - pull: new local file = server state + local changes not pushed yet;
 * - push: local changes since the base are sent as upserts/removals (the
 *   server checks the role and writes the audit log), then pulled back.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { stateKey, STATE_KINDS, type StateKind } from './service.js';
import type { ResultsClient } from './client.js';

const LIST_KEY: Record<StateKind, string> = { 'heal-decisions': 'decisions', quarantine: 'entries', 'triage-overrides': 'overrides' };

type Entry = Record<string, unknown>;
type StateFile = Record<string, unknown> & { version: number };

async function readJson(path: string): Promise<StateFile | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as StateFile;
  } catch {
    return undefined;
  }
}

async function writeAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, path);
}

const entries = (kind: StateKind, f: StateFile | undefined): Entry[] => ((f?.[LIST_KEY[kind]] as Entry[] | undefined) ?? []);

/** Local changes since the base snapshot. */
export function localChanges(kind: StateKind, local: StateFile | undefined, base: StateFile | undefined): { upsert: Entry[]; remove: string[] } {
  const key = stateKey(kind);
  const baseMap = new Map(entries(kind, base).map((e) => [key(e), JSON.stringify(e)]));
  const localList = entries(kind, local);
  const localKeys = new Set(localList.map(key));
  const upsert = localList.filter((e) => baseMap.get(key(e)) !== JSON.stringify(e));
  const remove = local ? [...baseMap.keys()].filter((k) => !localKeys.has(k)) : [];
  return { upsert, remove };
}

function apply(kind: StateKind, server: StateFile, change: { upsert: Entry[]; remove: string[] }): StateFile {
  const key = stateKey(kind);
  const list = entries(kind, server).filter((e) => !change.remove.includes(key(e)));
  for (const e of change.upsert) {
    const i = list.findIndex((x) => key(x) === key(e));
    if (i >= 0) list[i] = e;
    else list.push(e);
  }
  return { ...server, version: 1, [LIST_KEY[kind]]: list };
}

export interface SyncReport {
  kind: StateKind;
  pulled: number;
  pushed: number;
  pendingLocal: number;
  error?: string;
}

/**
 * Sync every shared-state kind. With `push: false` (e.g. a CI run token that may
 * not change decisions) local changes are kept locally and merged over the server copy.
 */
export async function syncSharedState(client: ResultsClient, eztestDir: string, o: { push?: boolean; kinds?: StateKind[] } = {}): Promise<SyncReport[]> {
  await mkdir(join(eztestDir, 'server-state'), { recursive: true });
  const out: SyncReport[] = [];
  for (const kind of o.kinds ?? [...STATE_KINDS]) {
    const localPath = join(eztestDir, `${kind}.json`);
    const basePath = join(eztestDir, 'server-state', `${kind}.base.json`);
    try {
      const local = await readJson(localPath);
      const base = await readJson(basePath);
      let change = localChanges(kind, local, base);
      let pushed = 0;
      let pushError: string | undefined;
      if (o.push && (change.upsert.length || change.remove.length)) {
        try {
          const r = await client.changeState(kind, change);
          pushed = r.changes;
          change = { upsert: [], remove: [] };
        } catch (e) {
          pushError = `local changes not shared: ${(e as Error).message}`; // kept locally, retried next sync
        }
      }
      const server = (await client.getState<StateFile>(kind)).data;
      await writeAtomic(basePath, server);
      await writeAtomic(localPath, apply(kind, server, change));
      out.push({ kind, pulled: entries(kind, server).length, pushed, pendingLocal: change.upsert.length + change.remove.length, ...(pushError ? { error: pushError } : {}) });
    } catch (e) {
      out.push({ kind, pulled: 0, pushed: 0, pendingLocal: 0, error: (e as Error).message });
    }
  }
  return out;
}
