#!/usr/bin/env node
/**
 * Bundle the EZTest Load agent (src/load/agent-main.ts) into one ES module,
 * dist-load-agent/eztest-load-agent.mjs, and its generator process
 * (src/load/engine/generator-worker.ts) into generator-worker.mjs next to it,
 * for the slim agent image
 * (deploy/load-agent/Dockerfile). Optional drivers (database, broker and
 * gRPC packages, the browser driver's binaries) stay external: an agent
 * image that needs them installs them next to the bundle.
 *
 *   node scripts/build-load-agent.mjs [outDir]
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = resolve(process.argv[2] ?? join(root, 'dist-load-agent'));
const started = Date.now();
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  legalComments: 'external',
  metafile: true,
  // A CommonJS dependency in an ES module bundle needs a require.
  banner: { js: "import { createRequire as __ezcr } from 'node:module'; const require = __ezcr(import.meta.url);" },
  external: ['pg', 'mssql', 'oracledb', 'kafkajs', 'amqplib', 'mqtt', '@grpc/grpc-js', '@grpc/proto-loader', 'ssh2', 'electron', 'tesseract.js', 'pdf-lib'],
  logLevel: 'warning',
};
const r = await build({ ...common, entryPoints: [join(root, 'src', 'load', 'agent-main.ts')], outfile: join(outDir, 'eztest-load-agent.mjs') });
// The generator processes (--generators, one per CPU by default) load this file from next to the agent.
const t = await build({ ...common, entryPoints: [join(root, 'src', 'load', 'engine', 'generator-worker.ts')], outfile: join(outDir, 'generator-worker.mjs') });
const bytes = [r, t].flatMap((x) => Object.values(x.metafile.outputs)).reduce((a, o) => a + o.bytes, 0);
console.log(`load agent: ${(bytes / 1024).toFixed(0)} KiB -> ${outDir} (${Date.now() - started} ms)`);
