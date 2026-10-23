/**
 * Package the extension as a .vsix with tfx-cli:
 *   1. validate (scripts/validate.mjs);
 *   2. copy azure-devops-extension-sdk (esm/SDK.min.js, MIT) and its licence into web/lib;
 *   3. tfx extension create --manifest-globs vss-extension.json --output-path dist/
 * Needs `npm install` in this directory first (tfx-cli and the SDK are its
 * devDependencies; they are not dependencies of the eztest package).
 * Options: --out <dir>, --publisher <id> (override for your Marketplace publisher), --rev-version
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateExtension } from './validate.mjs';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const modules = resolve(arg('--modules') ?? join(here, 'node_modules'));

const problems = validateExtension(here);
if (problems.length) {
  for (const p of problems) console.error(`invalid: ${p}`);
  process.exit(1);
}
const sdk = join(modules, 'azure-devops-extension-sdk', 'esm');
if (!existsSync(join(sdk, 'SDK.min.js'))) {
  console.error(`azure-devops-extension-sdk not found in ${modules}: run npm install in ${here}`);
  process.exit(1);
}
mkdirSync(join(here, 'web', 'lib'), { recursive: true });
// The minified ESM build is self-contained (XDM included).
copyFileSync(join(sdk, 'SDK.min.js'), join(here, 'web', 'lib', 'SDK.min.js'));
copyFileSync(join(modules, 'azure-devops-extension-sdk', 'LICENSE'), join(here, 'web', 'lib', 'LICENSE-azure-devops-extension-sdk.txt'));
const tfx = join(modules, '.bin', process.platform === 'win32' ? 'tfx.cmd' : 'tfx');
if (!existsSync(tfx)) {
  console.error(`tfx-cli not found in ${modules}: run npm install in ${here}`);
  process.exit(1);
}
const out = resolve(arg('--out') ?? join(here, 'dist'));
mkdirSync(out, { recursive: true });
const args = ['extension', 'create', '--root', here, '--manifest-globs', 'vss-extension.json', '--output-path', out, '--no-prompt', '--json'];
if (arg('--publisher')) args.push('--publisher', arg('--publisher'));
if (process.argv.includes('--rev-version')) args.push('--rev-version');
const r = spawnSync(tfx, args, { cwd: here, encoding: 'utf8', shell: false });
process.stdout.write(r.stdout ?? '');
process.stderr.write(r.stderr ?? '');
process.exitCode = r.status ?? 1;
