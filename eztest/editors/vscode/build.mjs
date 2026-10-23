// Bundle the extension (and vscode-languageclient) into dist/extension.js, and write
// THIRD_PARTY_NOTICES.md with the license of every package compiled into the bundle.
import { build } from 'esbuild';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [join(here, 'src/extension.ts')],
  outfile: join(here, 'dist/extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  minify: false,
  metafile: true,
  logLevel: 'info',
});

const names = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = input.split(/[\\/]/);
  const i = parts.lastIndexOf('node_modules');
  if (i >= 0) names.add(parts[i + 1].startsWith('@') ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1]);
}
const sections = [...names].sort().map((name) => {
  const dir = join(here, 'node_modules', ...name.split('/'));
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const lic = existsSync(dir) ? readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f)) : undefined;
  const text = lic ? readFileSync(join(dir, lic), 'utf8').trim() : `License: ${pkg.license ?? 'see package'}`;
  return `## ${name} ${pkg.version}\n\nLicense: ${pkg.license ?? 'unknown'}\n\n\`\`\`\n${text}\n\`\`\`\n`;
});
writeFileSync(join(here, 'THIRD_PARTY_NOTICES.md'), `# Third-party notices (EZTest VS Code extension)\n\nPackages compiled into dist/extension.js.\n\n${sections.join('\n')}`);

