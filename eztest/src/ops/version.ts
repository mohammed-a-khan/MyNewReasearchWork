/** The package version, read once from package.json (works from src/ and dist/). */
import { readFileSync } from 'node:fs';

/** The npm package name (the CLI is still called `eztest`). */
export const PACKAGE_NAME = '@eztech.com/eztest';

function readVersion(): string {
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === PACKAGE_NAME && pkg.version) return pkg.version;
    } catch {
      // try the next location
    }
  }
  return '0.0.0';
}

export const EZTEST_VERSION = readVersion();
