#!/usr/bin/env node
/**
 * `npm run test:acceptance [-- <filters>]`: the acceptance tests (test/acceptance) against real sites and apps.
 * They need a display for the visible recording browser: without one, and with xvfb-run on the machine, the run
 * goes through `xvfb-run -a`. EZTEST_ONLINE defaults to 1 here (the public-site tests need the internet); set
 * EZTEST_ONLINE=0 to leave them out. EZTEST_BROWSER=firefox runs them on Firefox. Two files run at a time
 * (TESTKIT_WORKERS changes it): visible browsers on real sites need the CPU.
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const testArgs = [join(root, 'tools', 'testkit', 'cli.mjs'), ...(args.some((a) => a.includes('acceptance')) ? [] : ['test/acceptance']), ...args];
// Visible browsers on real sites are heavy: two test files at a time unless TESTKIT_WORKERS says otherwise.
const env = { ...process.env, EZTEST_ONLINE: process.env.EZTEST_ONLINE ?? '1', TESTKIT_WORKERS: process.env.TESTKIT_WORKERS ?? '2' };
const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const xvfb = !hasDisplay && process.platform === 'linux' && spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;
if (!hasDisplay && !xvfb) console.warn('[test:acceptance] no display and no xvfb-run: recorded scenarios will be skipped');
const [cmd, cmdArgs] = xvfb ? ['xvfb-run', ['-a', process.execPath, ...testArgs]] : [process.execPath, testArgs];
const child = spawn(cmd, cmdArgs, { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
