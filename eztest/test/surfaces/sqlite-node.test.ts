/**
 * SQLite is optional: node:sqlite exists from Node.js 22.13 / 23.4 (22.5-22.12 behind --experimental-sqlite).
 * On an older Node.js, using SQLite fails with a clear message instead of a TypeError, and doctor says so.
 */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import { SqliteDbClient, loadSqlite, sqliteSupported, SQLITE_NODE_REQUIREMENT } from '../../src/surfaces/index.js';

const proc = process as unknown as { getBuiltinModule?: unknown };
const original = proc.getBuiltinModule;
afterEach(() => {
  proc.getBuiltinModule = original;
});

describe('SQLite and the Node.js version', () => {
  it('sqliteSupported: 22.13+, 23.4+, or 22.5+ with --experimental-sqlite', () => {
    expect(sqliteSupported('20.11.0', [])).toBe(false);
    expect(sqliteSupported('22.4.0', ['--experimental-sqlite'])).toBe(false);
    expect(sqliteSupported('22.5.0', [])).toBe(false);
    expect(sqliteSupported('22.5.0', ['--experimental-sqlite'])).toBe(true);
    expect(sqliteSupported('22.13.0', [])).toBe(true);
    expect(sqliteSupported('23.3.0', [])).toBe(false);
    expect(sqliteSupported('23.4.0', [])).toBe(true);
    expect(sqliteSupported('24.0.0', [])).toBe(true);
  });

  it('without node:sqlite (Node.js 20: no process.getBuiltinModule; or the module missing) SQLite fails with the requirement', () => {
    proc.getBuiltinModule = undefined;
    expect(() => loadSqlite()).toThrow(new RegExp(`${SQLITE_NODE_REQUIREMENT.replace(/[()+.]/g, '\\$&')}; this is Node\\.js .*use another database driver`));
    proc.getBuiltinModule = () => undefined;
    expect(() => new SqliteDbClient({ file: ':memory:', name: 'shop' })).toThrow(/SQLite \(node:sqlite\) needs Node\.js 22\.13\+ or 23\.4\+/);
  });

  it('on this Node.js it works', async () => {
    expect(sqliteSupported()).toBe(true);
    const db = new SqliteDbClient({ file: ':memory:', name: 'mem' });
    expect(await db.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    await db.close();
  });
});
