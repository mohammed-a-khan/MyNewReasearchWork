/**
 * File transfer, SSH and batch steps against REAL servers (Docker or env, see
 * brokers.ts): the G16 acceptance flow uploads a batch file over SFTP, waits
 * for the partner's ACK file, reads it as rows and compares them to the
 * database; SSH commands run only when allow-listed and check exit codes; a
 * batch job runs over SSH with parameters.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify as toYaml } from 'yaml';
import { loadConfig } from '../../src/config/index.js';
import { flattenStepResults, type JourneyResult } from '../../src/core/index.js';
import { createEngine } from '../../src/engine/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { SshSession } from '../../src/integration/files.js';
import { SqliteDbClient } from '../../src/surfaces/index.js';
import { sftpServer, skipNote, sshServer } from './brokers.js';

const [sftp, ssh] = await Promise.all([sftpServer(), sshServer()]);
if (!sftp) console.warn(`[eztest] ${skipNote('SFTP', 'EZTEST_SFTP_URL')}`);
if (!ssh) console.warn(`[eztest] ${skipNote('SSH', 'EZTEST_SSH_URL')}`);

function steps(j: JourneyResult): string {
  return flattenStepResults(j.steps).map(({ result: s }) => `${s.stepId}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');
}

async function runJourney(dir: string, ez: string): Promise<JourneyResult> {
  const engine = await createEngine(await loadConfig({ cwd: dir, environment: { SFTP_PASSWORD: sftp?.password ?? '', SSH_PASSWORD: ssh?.password ?? '' } }), { cwd: dir, runOptions: { stepTimeoutMs: 30_000 } });
  try {
    return (await engine.run([parseEzScript(ez)])).journeys[0];
  } finally {
    await engine.close();
  }
}

describe.skipIf(!sftp)('SFTP batch file round trip (G16 acceptance)', () => {
  let dir: string;
  let partner: SshSession;
  let stop = false;
  const batch = `batch-${randomUUID().slice(0, 6)}.csv`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eztest-sftp-'));
    await mkdir(join(dir, 'fixtures'), { recursive: true });
    await writeFile(join(dir, 'fixtures', batch), 'id,amount\nA1,10.00\nA2,25.50\n');
    const db = new SqliteDbClient({ file: join(dir, 'ledger.db') });
    await db.execute('CREATE TABLE batch_items (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    await db.execute("INSERT INTO batch_items VALUES ('A1', 'ACCEPTED'), ('A2', 'ACCEPTED')");
    await db.close();
    await writeFile(join(dir, 'eztest.config.yaml'), toYaml({
      outputDir: 'results', healing: { enabled: false },
      db: { connections: { ledger: { type: 'sqlite', file: join(dir, 'ledger.db') } }, queries: { inline: { ACKED: 'SELECT id, status FROM batch_items ORDER BY id' } } },
      files: { sftp: { partner: { host: sftp!.host, port: sftp!.port, username: sftp!.username, password: '${SFTP_PASSWORD}' } }, pollMs: 300 },
    }));
    // The partner system: picks up the batch from /in and answers with an ACK file in /out. Its
    // first connection records the server's host key in the project's .eztest/known_hosts (trust on
    // first use, like accepting it once with ssh); the journeys then check the key strictly.
    partner = new SshSession('partner-side', { ...sftp!, trustOnFirstUse: true }, dir);
    await partner.list('/in');
    void (async () => {
      while (!stop) {
        const files = await partner.list('/in').catch(() => []);
        const hit = files.find((f) => f.name === batch);
        if (hit) {
          const local = join(dir, 'partner-in.csv');
          await partner.download(hit.path, local);
          await writeFile(join(dir, 'ack.csv'), 'id,status\nA1,ACCEPTED\nA2,ACCEPTED\n');
          await partner.upload(join(dir, 'ack.csv'), `/out/ACK_${batch}`);
          await partner.remove(hit.path);
          return;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
  });
  afterAll(() => {
    stop = true;
    partner?.close();
  });

  it('uploads, waits for the ACK, reads it as rows and compares them with the database', async () => {
    const j = await runJourney(dir, `Journey: Partner batch
Upload "fixtures/${batch}" to SFTP "partner" at "/in"
Wait for a file matching "ACK_${batch.replace('.csv', '')}*.csv" in "/out" on SFTP "partner" within 30 s as ack
Read the download ack as rows into ackRows
Expect rows ackRows equal query "ACKED" on ledger by key "id"
List files in "/out" on SFTP "partner" matching "ACK_*" as acks
Expect len(acks) >= 1
Download "/out/ACK_${batch}" from SFTP "partner" as again
Delete "/out/ACK_${batch}" on SFTP "partner"
`);
    expect(j.status, steps(j)).toBe('passed');
  });

  it('fails clearly when the file never arrives', async () => {
    const j = await runJourney(dir, `Journey: No ACK
Wait for a file matching "NEVER_*.csv" in "/out" on SFTP "partner" within 2 s as nothing
`);
    expect(j.status).toBe('failed');
    expect(steps(j)).toMatch(/No file matching "NEVER_\*\.csv" appeared in \/out on SFTP partner within 2 s/);
  });
});

describe.skipIf(!ssh)('SSH commands and batch jobs (allow-listed)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eztest-ssh-'));
    await writeFile(join(dir, 'eztest.config.yaml'), toYaml({
      outputDir: 'results', healing: { enabled: false },
      files: { ssh: { 'batch-host': { host: ssh!.host, port: ssh!.port, username: ssh!.username, password: '${SSH_PASSWORD}', allowCommands: ['echo closing *', "sh -c 'exit 3'", 'echo closed *'] } } },
      batch: { jobs: { 'close-day': { ssh: 'batch-host', command: 'echo closed $${date}' } } },
    }));
    // Record the host key once (trust on first use); the journeys check it strictly.
    const prime = new SshSession('prime', { ...ssh!, trustOnFirstUse: true }, dir);
    await prime.exec('true', 10_000);
    prime.close();
  });

  it('runs allow-listed commands, checks exit codes and runs a batch job', async () => {
    const j = await runJourney(dir, `Journey: Close the day
Set variable day to "2026-01-31"
Run command "echo closing \${day}" on SSH "batch-host" as out
Expect response out "$.stdout" contains "closing 2026-01-31"
Run command "sh -c 'exit 3'" on SSH "batch-host" expecting exit code 3 as failed
Run batch job "close-day" with date=\${day} and wait up to 1 minute as job
Expect response job "$.stdout" contains "closed 2026-01-31"
`);
    expect(j.status, steps(j)).toBe('passed');
  });

  it('refuses a command that is not allow-listed', async () => {
    const j = await runJourney(dir, `Journey: Not allowed
Run command "rm -rf /tmp/x" on SSH "batch-host"
`);
    expect(j.status).toBe('failed');
    expect(steps(j)).toMatch(/Command "rm -rf \/tmp\/x" is not in files\.ssh\.batch-host\.allowCommands/);
  });

  it('checks host keys strictly: an unknown host is refused, trustOnFirstUse records it, a changed key is refused', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'eztest-hostkey-'));
    const host = (extra: Record<string, unknown> = {}) => toYaml({
      outputDir: 'results', healing: { enabled: false },
      files: { ssh: { 'batch-host': { host: ssh!.host, port: ssh!.port, username: ssh!.username, password: '${SSH_PASSWORD}', allowCommands: ['echo hi'], ...extra } } },
    });
    const known = join(fresh, '.eztest', 'known_hosts');
    await writeFile(join(fresh, 'eztest.config.yaml'), host());
    const refused = await runJourney(fresh, 'Journey: Unknown host\nRun command "echo hi" on SSH "batch-host" as out\n');
    expect(refused.status).toBe('failed');
    expect(steps(refused)).toMatch(/The host key of batch-host \(\[127\.0\.0\.1\]:\d+\) is not known \(ssh-\S+ SHA256:\S+\)\. Add it to .*known_hosts .*ssh-keyscan -p \d+ .*trustOnFirstUse: true/);
    expect(existsSync(known)).toBe(false);
    // Trust on first use: recorded, and accepted from then on with checking back on.
    await writeFile(join(fresh, 'eztest.config.yaml'), host({ trustOnFirstUse: true }));
    expect((await runJourney(fresh, 'Journey: First use\nRun command "echo hi" on SSH "batch-host" as out\n')).status).toBe('passed');
    const line = (await readFile(known, 'utf8')).trim();
    expect(line).toMatch(new RegExp(`^\\[127\\.0\\.0\\.1\\]:${ssh!.port} ssh-\\S+ [A-Za-z0-9+/=]+$`));
    await writeFile(join(fresh, 'eztest.config.yaml'), host());
    expect((await runJourney(fresh, 'Journey: Known now\nRun command "echo hi" on SSH "batch-host" as out\n')).status).toBe('passed');
    // Another key of the same type for the host: the key changed, refused even with trustOnFirstUse.
    const [name, type, key] = line.split(' ');
    const other = Buffer.from(key, 'base64');
    other[other.length - 1] ^= 0xff;
    await writeFile(known, `${name} ${type} ${other.toString('base64')}\n`);
    await writeFile(join(fresh, 'eztest.config.yaml'), host({ trustOnFirstUse: true }));
    const changed = await runJourney(fresh, 'Journey: Changed key\nRun command "echo hi" on SSH "batch-host" as out\n');
    expect(changed.status).toBe('failed');
    expect(steps(changed)).toMatch(/The host key of batch-host .* changed: it presented ssh-\S+ SHA256:\S+, but .*known_hosts has another/);
  });

  it('a connection lost after setup is reported by the next operation, not swallowed', async () => {
    const s = new SshSession('lossy', { ...ssh!, knownHosts: join(dir, '.eztest', 'known_hosts') }, dir);
    try {
      expect((await s.exec('echo up', 10_000)).stdout.trim()).toBe('up');
      // Kill the server side of this session: the connection drops under the session.
      await s.exec('kill -9 $PPID', 10_000).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
      await expect(s.exec('echo again', 10_000)).rejects.toThrow(/The SSH connection to lossy \(127\.0\.0\.1\) was (?:lost|closed by the server)/);
      // The next operation connects afresh.
      expect((await s.exec('echo back', 10_000)).stdout.trim()).toBe('back');
    } finally {
      s.close();
    }
  });
});
