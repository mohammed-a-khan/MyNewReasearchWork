#!/usr/bin/env node
/**
 * Generate THIRD_PARTY_NOTICES.md: the license text of every open-source
 * package EZTest ships or installs. That covers:
 *
 * - code compiled into the Studio bundle (found from esbuild's metafile, so nothing is missed);
 * - the runtime dependencies installed alongside EZTest, and their own dependencies, transitively
 *   (resolved the way Node.js resolves them, nested node_modules included);
 * - every optional peer dependency (database drivers such as pg, mssql and oracledb, messaging
 *   clients, ...): read from node_modules when it is installed here, otherwise listed with the
 *   license its registry entry declares (KNOWN_PEERS below) and a note that its text ships in it.
 *
 * Each license expression is checked: a dual license with a permissive choice ("MIT OR GPL-3.0")
 * is used under the permissive one, and anything without a permissive choice is flagged for review.
 *
 *   node scripts/third-party-notices.mjs          write the file
 *   node scripts/third-party-notices.mjs --check  exit 1 if it is out of date
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'THIRD_PARTY_NOTICES.md');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Optional peers that may not be installed where this runs: the license their npm registry entry declares. */
const KNOWN_PEERS = {
  pg: { license: 'MIT', homepage: 'https://github.com/brianc/node-postgres' },
  mssql: { license: 'MIT', homepage: 'https://github.com/tediousjs/node-mssql#readme' },
};

/** Licenses that allow use, modification and redistribution without copyleft obligations. */
const PERMISSIVE = new Set(['MIT', 'X11', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'BlueOak-1.0.0', 'Unlicense', 'CC0-1.0', 'Zlib', 'Python-2.0', 'UPL-1.0', 'CC-BY-4.0', 'CC-BY-3.0']);

/** "node_modules/@scope/name/..." -> "@scope/name" */
function packageOf(path) {
  const parts = relative(root, path).split(sep);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0) return undefined;
  return parts[i + 1].startsWith('@') ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1];
}

async function bundledPackages() {
  const esbuild = await import('esbuild');
  const entries = [join(root, 'src/studio/client/main.ts'), join(root, 'src/studio/client/styles/index.css')];
  const names = new Set(['pdfjs-dist']); // pdf.js is shipped as its own self-hosted module (Assurance viewer)
  for (const entry of entries) {
    const r = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, metafile: true, logLevel: 'silent', platform: 'browser', loader: { '.css': 'css' }, outdir: 'x' });
    for (const input of Object.keys(r.metafile.inputs)) {
      const name = packageOf(join(root, input));
      if (name) names.add(name);
    }
  }
  return names;
}

/** The directory Node.js would load `name` from when required from `fromDir`. */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === root || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
    if (relative(root, dir).startsWith('..')) return undefined;
  }
}

function readMeta(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

function licenseOf(meta) {
  if (typeof meta.license === 'string') return meta.license;
  if (meta.license && typeof meta.license === 'object' && meta.license.type) return meta.license.type;
  if (Array.isArray(meta.licenses)) return meta.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ');
  return 'UNKNOWN';
}

/** The licenses an SPDX-like expression offers: alternatives (OR) of requirement sets (AND). */
function alternatives(expr) {
  // Old package.json spellings such as "MIT/X11" list alternatives with a slash.
  const clean = expr.replace(/[()]/g, ' ').replace(/\s*\/\s*/g, ' OR ').trim();
  return clean.split(/\s+OR\s+/i).map((alt) => alt.split(/\s+AND\s+/i).map((x) => x.trim()).filter(Boolean));
}

/** How a license expression is used: permissive, a chosen permissive alternative, or flagged for review. */
function review(license) {
  const alts = alternatives(license);
  const ok = alts.find((set) => set.length && set.every((l) => PERMISSIVE.has(l)));
  if (!ok) return { status: 'review', note: `no permissive alternative in "${license}": review before distributing` };
  if (alts.length > 1) return { status: 'chosen', chosen: ok.join(' AND '), note: `dual-licensed "${license}": used under ${ok.join(' AND ')}` };
  return { status: 'ok' };
}

function licenseText(dir) {
  const meta = readMeta(dir);
  const files = readdirSync(dir).filter((f) => /^(licen[sc]e|copying|notice)(\.|-|$)/i.test(f)).sort();
  const texts = files.map((f) => `#### ${f}\n\n\`\`\`text\n${readFileSync(join(dir, f), 'utf8').trim()}\n\`\`\``);
  return { name: meta.name, version: meta.version, license: licenseOf(meta), homepage: meta.homepage ?? meta.repository?.url ?? '', texts };
}

const bundled = await bundledPackages();
const direct = new Set(Object.keys(pkg.dependencies ?? {}));

/** name@version -> { dir, how } */
const entries = new Map();
const add = (dir, how) => {
  const meta = readMeta(dir);
  const key = `${meta.name}@${meta.version}`;
  const e = entries.get(key) ?? { dir, how: new Set() };
  e.how.add(how);
  entries.set(key, e);
  return key;
};

for (const name of bundled) {
  const dir = resolvePackageDir(name, root);
  if (dir) add(dir, 'bundled');
}

// Runtime dependencies and theirs, transitively (dependencies and installed optional dependencies).
const queue = [...direct].map((name) => ({ name, from: root, how: 'dependency' }));
const visited = new Set();
while (queue.length) {
  const { name, from, how } = queue.shift();
  const dir = resolvePackageDir(name, from);
  if (!dir) continue;
  const m = readMeta(dir);
  // Platform-specific builds (an "os" or "cpu" field, e.g. @napi-rs/canvas-linux-x64-gnu) depend on the machine:
  // they are left out so the file is the same everywhere.
  if (how === 'transitive dependency' && (m.os || m.cpu)) continue;
  const key = add(dir, how);
  if (visited.has(key)) continue;
  visited.add(key);
  const meta = readMeta(dir);
  for (const dep of [...Object.keys(meta.dependencies ?? {}), ...Object.keys(meta.optionalDependencies ?? {})]) {
    queue.push({ name: dep, from: dir, how: 'transitive dependency' });
  }
}

// Every optional peer: installed here, or listed from KNOWN_PEERS.
const notInstalled = [];
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  const dir = resolvePackageDir(name, root);
  if (dir) add(dir, 'optional peer');
  else notInstalled.push({ name, range, ...(KNOWN_PEERS[name] ?? { license: 'UNKNOWN', homepage: '' }) });
}

const rows = [...entries.entries()]
  .map(([key, e]) => ({ key, ...licenseText(e.dir), how: [...e.how] }))
  .sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version, 'en', { numeric: true }) : a.name < b.name ? -1 : 1));
const peerRows = notInstalled.sort((a, b) => (a.name < b.name ? -1 : 1));
const order = ['bundled', 'dependency', 'transitive dependency', 'optional peer'];
const howOf = (r) => order.filter((h) => r.how.includes(h)).join(', ');

const flagged = [...rows, ...peerRows].map((r) => ({ r, v: review(r.license) })).filter((x) => x.v.status !== 'ok');
const missing = rows.filter((r) => !r.texts.length).map((r) => r.key);
const lines = [
  '# Third-party notices',
  '',
  'EZTest is original work. It uses the open-source packages below, each under its own license.',
  'Packages marked **bundled** are compiled into the EZTest Studio files shipped in this package;',
  'packages marked **dependency** are installed alongside EZTest from npm, and **transitive dependency**',
  'packages are installed because a dependency needs them; packages marked **optional peer** are installed',
  'by you only when you use them (e.g. a database driver). This file is generated by',
  '`scripts/third-party-notices.mjs`; do not edit it by hand.',
  '',
  '## License review',
  '',
  ...(flagged.length
    ? flagged.map(({ r, v }) => `- **${r.name}${r.version ? ` ${r.version}` : ''}**: ${v.note}.`)
    : ['Every package is under a permissive license.']),
  '',
  '| Package | Version | License | How it ships |',
  '|---|---|---|---|',
  ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} | ${howOf(r)} |`),
  ...peerRows.map((r) => `| ${r.name} | ${r.range} (not installed here) | ${r.license} | optional peer |`),
  '',
  ...rows.flatMap((r) => [`## ${r.name} ${r.version} (${r.license})`, '', r.homepage ? `${r.homepage}\n` : '', ...(r.texts.length ? r.texts : [`_No license file in the package; its package.json declares: ${r.license}._`]), '']),
  ...peerRows.flatMap((r) => [`## ${r.name} ${r.range} (${r.license})`, '', r.homepage ? `${r.homepage}\n` : '', '_An optional peer you install yourself; it was not installed where this file was generated. Its license text ships in the package._', '']),
];
const text = lines.join('\n').replace(/\n{3,}/g, '\n\n');

if (process.argv.includes('--check')) {
  const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
  if (current !== text) {
    console.error('THIRD_PARTY_NOTICES.md is out of date. Run: node scripts/third-party-notices.mjs');
    process.exit(1);
  }
  console.log(`THIRD_PARTY_NOTICES.md is up to date (${rows.length + peerRows.length} packages).`);
} else {
  writeFileSync(out, text);
  const count = (h) => rows.filter((r) => r.how.includes(h)).length;
  console.log(`wrote THIRD_PARTY_NOTICES.md: ${rows.length + peerRows.length} packages (${count('bundled')} bundled, ${count('dependency')} dependencies, ${count('transitive dependency')} transitive, ${count('optional peer') + peerRows.length} optional peers)`);
}
for (const { r, v } of flagged) console.warn(`license: ${r.name}: ${v.note}`);
if (missing.length) console.warn(`no license file found in: ${missing.join(', ')}`);
