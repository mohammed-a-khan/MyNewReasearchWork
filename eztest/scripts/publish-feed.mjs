#!/usr/bin/env node
/**
 * Publish the built package to a private npm feed (Azure Artifacts, GitHub Packages, Artifactory, ...).
 *
 *   EZTEST_FEED_REGISTRY=https://<feed registry url>/ npm run publish:feed            # tag: beta for prereleases, else latest
 *   EZTEST_FEED_REGISTRY=... npm run publish:feed -- --dry-run
 *   EZTEST_FEED_REGISTRY=... npm run publish:feed -- --prune      # Azure Artifacts: then delete every older version
 *
 * --prune (Azure Artifacts feeds only) deletes the package's other versions after a successful publish and removes
 * them from the feed's recycle bin too, so they stop counting against the Artifacts storage. It authenticates with
 * EZTEST_FEED_TOKEN (a PAT with Packaging read, write and manage) when set.
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
const prune = process.argv.includes('--prune');
const extra = process.argv.slice(2).filter((a) => a !== '--prune');
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
if (prune && !dryRun) await pruneOlderVersions([].concat(published).filter((v) => v !== pkg.version));

/** Azure Artifacts: delete the given versions of this package, then purge them from the recycle bin. */
async function pruneOlderVersions(versions) {
  const m = /^https:\/\/pkgs\.dev\.azure\.com\/([^/]+)\/(?:([^/]+)\/)?_packaging\/([^/@]+)[^/]*\/npm\/registry\/?$/.exec(registry);
  if (!m) {
    console.error('--prune: the registry is not an Azure Artifacts npm feed; nothing deleted.');
    return;
  }
  if (!versions.length) {
    console.log('--prune: no older versions on the feed.');
    return;
  }
  const [, org, project, feed] = m;
  // Through HTTPS_PROXY like every other EZTest call (Node's own fetch ignores it); dist/ was just built.
  const { envProxyFetch: fetch } = await import(new URL('../dist/surfaces/proxy.js', import.meta.url).href);
  const base = `https://pkgs.dev.azure.com/${org}/${project ? `${project}/` : ''}_apis/packaging/feeds/${feed}/npm`;
  const token = process.env.EZTEST_FEED_TOKEN;
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}` } : {}) };
  const [scope, name] = pkg.name.startsWith('@') ? pkg.name.slice(1).split('/') : [undefined, pkg.name];
  const path = scope ? `@${scope}/${name}` : name;
  for (const v of versions) {
    const r = await fetch(`${base}/${path}/versions/${encodeURIComponent(v)}?api-version=7.1-preview.1`, { method: 'DELETE', headers });
    console.log(`--prune: deleted ${pkg.name}@${v}: HTTP ${r.status}`);
  }
  const purge = await fetch(`${base}/RecycleBin/packagesBatch?api-version=7.1-preview.1`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operation: 'PermanentDelete', packages: versions.map((version) => ({ id: pkg.name, version })) }),
  });
  console.log(`--prune: removed ${versions.length} version(s) from the recycle bin: HTTP ${purge.status}`);
}
