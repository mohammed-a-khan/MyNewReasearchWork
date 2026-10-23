#!/usr/bin/env node
/**
 * Bundle the EZTest Studio client (src/studio/client) into
 * dist/studio/client/app.js and app.css with esbuild. Runs after `tsc` in
 * `npm run build`, and reuses the compiled `buildClient` so the server's
 * on-the-fly dev build and the published bundle are made the same way.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { buildClient } = await import(pathToFileURL(join(root, 'dist', 'studio', 'bundle.js')).href);
const outDir = join(root, 'dist', 'studio', 'client');
const started = Date.now();
const b = await buildClient({ base: join(root, 'src', 'studio'), outDir, minify: true });
const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(0)} KiB`;
console.log(`studio client: ${kb(b.js)} js, ${kb(b.css)} css -> ${outDir} (${Date.now() - started} ms)`);

// pdf.js for the document viewer (Assurance): self-hosted ES modules next to the client bundle.
const { buildPdfAssets } = await import(pathToFileURL(join(root, 'dist', 'studio', 'routes', 'assurance-pdfjs.js')).href);
const pdf = await buildPdfAssets({ outDir: join(outDir, 'pdfjs') });
console.log(`studio pdf.js: ${Object.entries(pdf).map(([f, t]) => `${f} ${kb(t)}`).join(', ')} -> ${join(outDir, 'pdfjs')}`);
