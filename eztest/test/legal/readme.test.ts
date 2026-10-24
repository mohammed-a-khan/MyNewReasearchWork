/**
 * The README says what is true: every CLI command is in it, the features that
 * were never run against the real thing say so, and the Node.js requirement
 * covers SQLite.
 */
import { describe, expect, it } from '../support/testkit.js';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildProgram } from '../../src/cli/program.js';

const ROOT = resolve(__dirname, '../..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const row = (area: string) => README.split('\n').find((l) => l.startsWith(`| ${area} |`)) ?? '';

describe('README', () => {
  it('names every top-level command of the CLI', () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['lint', 'queries', 'elements', 'coverage', 'manual']));
    const missing = names.filter((n) => !new RegExp(`\\beztest ${n.replace(/-/g, '\\-')}\\b`).test(README));
    expect(missing).toEqual([]);
  });

  it('states the test status of what never ran against the real product', () => {
    expect(row('Native mobile')).toMatch(/Android driver and agent have never run on a real device or emulator/);
    expect(row('Native mobile')).toMatch(/iOS agent has never been compiled/);
    expect(row('Desktop and legacy')).toMatch(/Windows UI Automation and SAP GUI agents have never run/);
    expect(row('Dynamics 365')).toMatch(/EZTest's own stand-in/);
    expect(row('Salesforce')).toMatch(/EZTest's own stand-in/);
    expect(row('Packaged apps')).toMatch(/EZTest's own stand-ins of each product/);
    expect(row('Components')).toMatch(/Kendo, DevExtreme, PrimeNG, Angular Material, SAP UI5 and Oracle JET adapters are tested against EZTest's own stand-ins/);
    expect(row('Surfaces')).toMatch(/PostgreSQL, Oracle, SQL Server, MariaDB 10\.11 and MySQL 8\.4 run against live servers; SQL Server Kerberos and Entra ID are tested by mapping and against local token servers only/);
  });

  it('states the Node.js requirement of SQLite', () => {
    expect(README).toMatch(/SQLite .* needs Node\.js 22\.13\+ or 23\.4\+ \(22\.5 to 22\.12 with `--experimental-sqlite`\)/);
  });
});
