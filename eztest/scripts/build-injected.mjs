#!/usr/bin/env node
/**
 * Bundle EZTest's page-side engines: the selector engine
 * (src/browser/injected/page -> dist/browser/injected/engine.bundle.js) and
 * the accessibility engine (src/a11y/page -> dist/a11y/a11y.bundle.js).
 * Runs after `tsc` in `npm run build` and reuses the compiled builders, so
 * the on-the-fly builds used from source and the published bundles are made
 * the same way.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = join(root, 'dist', 'browser', 'injected');
const { buildEngineSource, PREBUILT_ENGINE } = await import(pathToFileURL(join(dir, 'engine.js')).href);
const started = Date.now();
const src = buildEngineSource({ minify: true });
writeFileSync(PREBUILT_ENGINE, src);
console.log(`page engine: ${(Buffer.byteLength(src) / 1024).toFixed(0)} KiB -> ${PREBUILT_ENGINE} (${Date.now() - started} ms)`);

const { buildA11ySource, PREBUILT_A11Y } = await import(pathToFileURL(join(root, 'dist', 'a11y', 'bundle.js')).href);
const a11yStarted = Date.now();
const a11ySrc = buildA11ySource({ minify: true });
writeFileSync(PREBUILT_A11Y, a11ySrc);
console.log(`accessibility engine: ${(Buffer.byteLength(a11ySrc) / 1024).toFixed(0)} KiB -> ${PREBUILT_A11Y} (${Date.now() - a11yStarted} ms)`);
