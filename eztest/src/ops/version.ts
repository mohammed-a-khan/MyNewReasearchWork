/** The package version, read once from package.json (works from src/ and dist/). */
import { readFileSync } from 'node:fs';

function readVersion(): string {
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'eztest' && pkg.version) return pkg.version;
    } catch {
      // try the next location
    }
  }
  return '0.0.0';
}

export const EZTEST_VERSION = readVersion();
