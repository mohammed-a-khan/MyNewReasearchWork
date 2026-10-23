/** Every shipped open-source package is credited with its license text, and only permissive licenses are used. */
import { describe, expect, it } from '../support/testkit.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'MPL-2.0']);

describe('third-party notices', () => {
  it('THIRD_PARTY_NOTICES.md matches what is bundled and installed', () => {
    expect(() => execFileSync(process.execPath, [join(root, 'scripts/third-party-notices.mjs'), '--check'], { cwd: root, stdio: 'pipe' })).not.toThrow();
  });

  it('ships only permissively licensed packages, each with its license text', () => {
    const text = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const rows = text.split('\n').filter((l) => /^\| [^-P|]/.test(l)).map((l) => l.split('|').map((c) => c.trim()));
    expect(rows.length).toBeGreaterThan(10);
    for (const [, name, , license] of rows) {
      // An SPDX "(A OR B)" choice is fine when one of the options is allowed (oracledb: Apache-2.0 OR UPL-1.0).
      const options = license.replace(/^\((.*)\)$/, '$1').split(/\s+OR\s+/);
      expect(options.some((l) => ALLOWED.has(l)), `${name} is ${license}`).toBe(true);
      expect(text).toContain(`## ${name} `);
    }
    expect(text).not.toContain('_No license file in the package');
  });

  it('is part of the published package', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('THIRD_PARTY_NOTICES.md');
  });
});
