#!/usr/bin/env node
/**
 * Publish the built package to a private npm feed (Azure Artifacts, GitHub Packages, Artifactory, ...).
 *
 *   EZTEST_FEED_REGISTRY=https://<feed registry url>/ npm run publish:feed            # tag: beta for prereleases, else latest
 *   EZTEST_FEED_REGISTRY=... npm run publish:feed -- --dry-run
 *
 * The feed's address and credentials stay outside the repository: the registry comes from the environment, and
 * npm reads the token from the user's ~/.npmrc (or the pipeline's npmAuthenticate task). It builds first and checks
 * that the version is not already on the feed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const registry = process.env.EZTEST_FEED_REGISTRY;
if (!registry) {
  console.error('Set EZTEST_FEED_REGISTRY to the feed\'s npm registry URL (e.g. https://pkgs.dev.azure.com/<org>/_packaging/<feed>/npm/registry/).');
  process.exit(2);
}
const extra = process.argv.slice(2);
const dryRun = extra.includes('--dry-run');
const tag = /-/.test(pkg.version) ? (pkg.version.split('-')[1].split('.')[0] || 'next') : 'latest';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args, opts = {}) => execFileSync(npm, args, { cwd: root, stdio: 'inherit', ...opts });

let published = [];
try {
  published = JSON.parse(execFileSync(npm, ['view', pkg.name, 'versions', '--json', '--registry', registry], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '[]');
} catch {
  // not on the feed yet
}
if ([].concat(published).includes(pkg.version)) {
  console.error(`${pkg.name}@${pkg.version} is already on the feed: raise the version first (e.g. npm version prerelease --preid beta).`);
  process.exit(1);
}
run(['run', 'build']);
run(['publish', '--registry', registry, '--tag', tag, '--ignore-scripts', ...extra]);
console.log(`${dryRun ? 'Would publish' : 'Published'} ${pkg.name}@${pkg.version} with tag "${tag}".`);
