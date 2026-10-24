/** Every shipped open-source package is credited with its license text, and only permissive licenses are used. */
import { describe, expect, it } from '../support/testkit.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'MPL-2.0']);
/** Dependencies of dependencies may also be under these permissive licenses (public domain dedications and the like). */
const ALLOWED_TRANSITIVE = new Set([...ALLOWED, 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0', 'MIT-0', 'Zlib', 'Python-2.0', 'CC-BY-4.0', 'CC-BY-3.0']);

describe('third-party notices', () => {
  it('THIRD_PARTY_NOTICES.md matches what is bundled and installed', () => {
    expect(() => execFileSync(process.execPath, [join(root, 'scripts/third-party-notices.mjs'), '--check'], { cwd: root, stdio: 'pipe' })).not.toThrow();
  });

  it('ships only permissively licensed packages, each with its license text', () => {
    const text = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const rows = text.split('\n').filter((l) => /^\| [^-P|]/.test(l)).map((l) => l.split('|').map((c) => c.trim()));
    expect(rows.length).toBeGreaterThan(10);
    const review = text.slice(text.indexOf('## License review'), text.indexOf('| Package |'));
    const section = (name: string, version: string) => {
      const start = text.indexOf(`\n## ${name} ${version} `);
      return start < 0 ? '' : text.slice(start, text.indexOf('\n## ', start + 1) >>> 0);
    };
    for (const [, name, version, license, how] of rows) {
      // An SPDX "(A OR B)" choice is fine when one of the options is allowed (oracledb: Apache-2.0 OR UPL-1.0).
      const options = license.replace(/[()]/g, ' ').trim().split(/\s+OR\s+/).map((o) => o.split(/\s+AND\s+/));
      const set = how === 'transitive dependency' ? ALLOWED_TRANSITIVE : ALLOWED;
      const allowed = options.some((all) => all.every((l) => set.has(l.trim())));
      expect(text).toContain(`## ${name} `);
      if (how !== 'transitive dependency') {
        // What EZTest bundles, depends on directly or names as a peer: an allowed license and its text.
        expect(allowed, `${name} is ${license}`).toBe(true);
        if (!version.includes('not installed')) expect(section(name, version), name).not.toContain('_No license file in the package');
      } else if (!allowed) {
        // A dependency of a dependency without an allowed license is flagged in the license review.
        expect(review, `${name} (${license}) is not in the license review`).toContain(`**${name} ${version}**`);
      }
    }
  });

  it('includes transitive runtime dependencies and every optional peer, and flags dual and unclear licenses', () => {
    const text = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { peerDependencies: Record<string, string> };
    const table = text.split('\n').filter((l) => /^\| [^-P|]/.test(l)).map((l) => l.split('|').map((c) => c.trim()));
    const how = (name: string) => table.filter((r) => r[1] === name).map((r) => r[4]).join(', ');
    for (const peer of Object.keys(pkg.peerDependencies)) expect(how(peer), peer).toContain('optional peer');
    expect(table.find((r) => r[1] === 'pg')).toEqual(['', 'pg', '>=8 (not installed here)', 'MIT', 'optional peer', '']);
    expect(table.find((r) => r[1] === 'mssql')?.[3]).toBe('MIT');
    // exceljs -> jszip, a dependency of a dependency: listed, and its dual license resolved to MIT.
    expect(how('jszip')).toContain('transitive dependency');
    expect(text).toMatch(/- \*\*jszip [\d.]+\*\*: dual-licensed "\(MIT OR GPL-3\.0-or-later\)": used under MIT\./);
    expect(table.filter((r) => r[4] === 'transitive dependency').length).toBeGreaterThan(50);
  });

  it('is part of the published package', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('THIRD_PARTY_NOTICES.md');
  });
});
