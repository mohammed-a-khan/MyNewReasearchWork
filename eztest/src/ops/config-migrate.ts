/**
 * Configuration schema versioning (`configVersion`) and `eztest upgrade-config`.
 *
 * Every breaking change to eztest.config.* gets a migration from version N to
 * N+1 here, so `eztest upgrade-config` can bring any older file forward while
 * keeping comments and layout (YAML is edited through the yaml Document API).
 * Version 1 is the baseline: no migrations exist yet, and upgrading a file
 * without `configVersion` only stamps `configVersion: 1`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseDocument, type Document } from 'yaml';
import { CONFIG_VERSION } from '../config/schema.js';

export interface ConfigMigration {
  from: number;
  to: number;
  /** What changes, for the upgrade report. */
  describe: string;
  /** Apply to a parsed YAML document (JSON configs are parsed as YAML too); returns notes per edit. */
  migrate(doc: Document): string[];
}

/** Ordered migrations. Empty while the schema is at its v1 baseline. */
export const CONFIG_MIGRATIONS: ConfigMigration[] = [];

export interface UpgradeResult {
  from: number;
  to: number;
  changed: boolean;
  changes: string[];
  text: string;
}

export function upgradeConfigText(text: string, o: { json?: boolean; migrations?: ConfigMigration[]; target?: number } = {}): UpgradeResult {
  const migrations = o.migrations ?? CONFIG_MIGRATIONS;
  const target = o.target ?? CONFIG_VERSION;
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`Config is not valid YAML/JSON: ${doc.errors[0].message}`);
  const raw = doc.get('configVersion');
  const from = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(from) || from < 1) throw new Error(`configVersion must be a positive integer, got ${String(raw)}`);
  if (from > target) throw new Error(`This config is configVersion ${from}, newer than this EZTest supports (${target}). Upgrade EZTest.`);
  const changes: string[] = [];
  let v = from;
  while (v < target) {
    const m = migrations.find((x) => x.from === v);
    if (!m) throw new Error(`No migration from configVersion ${v} to ${v + 1}`);
    changes.push(`v${m.from} -> v${m.to}: ${m.describe}`, ...m.migrate(doc).map((c) => `  ${c}`));
    v = m.to;
  }
  const stamped = raw !== undefined && Number(raw) === target;
  if (!stamped) {
    if (raw === undefined) doc.add(doc.createPair('configVersion', target));
    else doc.set('configVersion', target);
    // Keep configVersion as the first key so it is seen first.
    // A comment above the old first key stays at the top of the file.
    const map = doc.contents as { items?: Array<{ key?: { commentBefore?: string | null } }> } | null;
    if (raw === undefined && map?.items && map.items.length > 1) {
      const added = map.items.pop()!;
      const first = map.items[0];
      if (first?.key && typeof first.key === 'object' && first.key.commentBefore && added.key && typeof added.key === 'object') {
        added.key.commentBefore = first.key.commentBefore;
        first.key.commentBefore = null;
      }
      map.items.unshift(added);
    }
    changes.push(raw === undefined ? `added configVersion: ${target}` : `configVersion: ${from} -> ${target}`);
  }
  const out = o.json ? JSON.stringify(doc.toJSON(), null, 2) + '\n' : doc.toString();
  return { from, to: target, changed: changes.length > 0, changes, text: out };
}

export async function upgradeConfigFile(file: string, o: { write?: boolean } = {}): Promise<UpgradeResult> {
  const text = await readFile(file, 'utf8');
  const r = upgradeConfigText(text, { json: extname(file).toLowerCase() === '.json' });
  if (r.changed && o.write !== false) await writeFile(file, r.text);
  return r;
}
