/**
 * Docker image smoke test: the official image runs `eztest --version`,
 * `doctor --json` (Chromium launches inside) and a real journey against a page
 * served on the host. Skips when Docker or the image is unavailable; build the
 * image first with `docker build -t eztest:latest .` (or set EZTEST_DOCKER_IMAGE).
 */
import { describe, expect, it } from '../support/testkit.js';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from '../runner/fixtures.js';

const IMAGE = process.env.EZTEST_DOCKER_IMAGE ?? 'eztest:latest';
const docker = (args: string[], timeout = 120_000) => spawnSync('docker', args, { encoding: 'utf8', timeout });
function dockerAsync(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const available = (() => {
  try {
    return docker(['info'], 15_000).status === 0 && docker(['image', 'inspect', IMAGE], 15_000).status === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!available)(`Docker image ${IMAGE}`, () => {
  it('reports its version and a healthy doctor', () => {
    const v = docker(['run', '--rm', IMAGE, '--version']);
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const d = docker(['run', '--rm', IMAGE, 'doctor', '--json', '--no-db']);
    const report = JSON.parse(d.stdout);
    expect(report.checks.find((c: { name: string }) => c.name === 'chromium')).toMatchObject({ status: 'ok' });
    expect(report.node).toMatch(/^22\./);
  }, 180_000);

  it('runs a journey with evidence and reports', async () => {
    const server = createServer((_q, r) => {
      r.setHeader('content-type', 'text/html');
      r.end('<h1>Welcome</h1><button onclick="this.textContent=\'Clicked\'">Go</button>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (server.address() as AddressInfo).port;
      const dir = await tempDir('docker');
      await mkdir(join(dir, 'journeys'));
      await writeFile(join(dir, 'journeys', 'a.ez'), 'Journey: Docker smoke\n\nOpen "/"\n  Expect the page contains "Welcome"\nClick the "Go" button\n  Expect the page contains "Clicked"\n');
      await writeFile(join(dir, 'eztest.config.yaml'), `baseUrl: http://127.0.0.1:${port}\n`);
      await chmod(dir, 0o777);
      await chmod(join(dir, 'journeys'), 0o777);
      // Async: the page is served by this process, so its event loop must keep running.
      const r = await dockerAsync(['run', '--rm', '--network', 'host', '-v', `${dir}:/work`, IMAGE, 'run', '--reporter', 'json,junit']);
      expect(r.stdout + r.stderr).toMatch(/1 journeys: 1 passed/);
      expect(r.status).toBe(0);
      const runs = (await readdir(join(dir, 'eztest-results'))).filter((x) => x.startsWith('run-'));
      const verify = docker(['run', '--rm', '-v', `${dir}:/work`, IMAGE, 'evidence', 'verify', `eztest-results/${runs[0]}`]);
      expect(verify.stdout).toMatch(/^VALID/);
    } finally {
      server.close();
    }
  }, 240_000);
});
