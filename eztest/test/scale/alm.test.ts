/**
 * The Jira publisher against a recorded mock API (dedup bugs with evidence
 * attachments, run links, JQL requirements as traceability gaps), dry-run
 * mode, and the absence of test-management publishers.
 */
import { describe, expect, it } from '../support/testkit.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunResult } from '../../src/core/index.js';
import { computeTraceability } from '../../src/insights/index.js';
import { JiraClient, jiraRequirements } from '../../src/alm-jira/index.js';
import { registerFirstPartyPlugins, runPublishers } from '../../src/plugins/index.js';
import { fakeShardRun } from './fixtures-run.js';
import { startRecorder, type Recorded } from './mock-http.js';

/** A run dir with three journeys (two pass, one fails), each with a screenshot, tagged for the target. */
async function taggedRun(tags: string[][]): Promise<{ dir: string; run: RunResult }> {
  const base = await mkdtemp(join(tmpdir(), 'ez-alm-'));
  const dir = await fakeShardRun(base, `run-alm-${Math.random().toString(36).slice(2, 7)}`, [{ id: 'login', status: 'passed' }, { id: 'search', status: 'passed' }, { id: 'pay', status: 'failed' }], new Date().toISOString());
  const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunResult;
  run.journeys.forEach((j, i) => (j.tags = tags[i] ?? []));
  await writeFile(join(dir, 'run.json'), JSON.stringify(run));
  return { dir, run };
}

const secrets = async (v: string) => v.replace('secret://env/', 'resolved-');

describe('Jira', () => {
  /** A tiny Jira: issues with labels, comments, attachments, remote links, JQL by label/key list. */
  async function mockJira() {
    const issues: Array<{ key: string; labels: string[]; summary: string; status: string; comments: number; attachments: string[]; links: string[]; description: unknown }> = [
      { key: 'PAY-1', labels: [], summary: 'Pay by card', status: 'In Progress', comments: 0, attachments: [], links: [], description: '' },
      { key: 'PAY-2', labels: [], summary: 'Refund', status: 'To Do', comments: 0, attachments: [], links: [], description: '' },
    ];
    let n = 100;
    const srv = await startRecorder((r: Recorded) => {
      if (r.headers.authorization !== `Basic ${Buffer.from('qa@example.com:resolved-JIRA_TOKEN').toString('base64')}`) return { status: 401 };
      const m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/(comment|attachments|remotelink)$/.exec(r.path);
      if (r.path === '/rest/api/3/search/jql') {
        const jql = JSON.parse(r.body).jql as string;
        const label = /labels = "([^"]+)"/.exec(jql)?.[1];
        const hits = label ? issues.filter((i) => i.labels.includes(label) && i.status !== 'Done') : jql.includes('issuetype = Story') ? issues.filter((i) => !i.labels.length) : [];
        return { body: { issues: hits.map((i) => ({ key: i.key, fields: { summary: i.summary, status: { name: i.status } } })) } };
      }
      if (r.path === '/rest/api/3/issue' && r.method === 'POST') {
        const f = JSON.parse(r.body).fields;
        const key = `PAY-${++n}`;
        issues.push({ key, labels: f.labels, summary: f.summary, status: 'To Do', comments: 0, attachments: [], links: [], description: f.description });
        return { status: 201, body: { key } };
      }
      if (m) {
        const issue = issues.find((i) => i.key === m[1])!;
        if (m[2] === 'comment') issue.comments++;
        if (m[2] === 'attachments') {
          if (r.headers['x-atlassian-token'] !== 'no-check') return { status: 403 };
          issue.attachments.push(/filename="([^"]+)"/.exec(r.body)?.[1] ?? '?');
        }
        if (m[2] === 'remotelink') issue.links.push(JSON.parse(r.body).object.url);
        return { status: 201, body: {} };
      }
      return { status: 404 };
    });
    return { srv, issues };
  }

  it('files one bug per failure signature with evidence attached; a repeat failure comments instead', async () => {
    await registerFirstPartyPlugins();
    const { srv, issues } = await mockJira();
    try {
      const spec = { use: 'jira', baseUrl: srv.url, deployment: 'cloud', email: 'qa@example.com', apiToken: 'secret://env/JIRA_TOKEN', projectKey: 'PAY' };
      const first = await taggedRun([]);
      const [r1] = await runPublishers([spec], { run: first.run, runDir: first.dir, resolveSecret: secrets, runUrl: 'https://eztest.example/ui/p/pay/runs/1' });
      expect(r1).toMatchObject({ ok: true, message: '1 bug(s) created, 0 existing bug(s) commented' });
      const bug = issues.find((i) => i.labels.includes('eztest'))!;
      expect(bug.labels.some((l) => l.startsWith('ezsig-'))).toBe(true);
      expect(bug.summary).toMatch(/^\[EZTest\] Journey pay: /);
      expect(bug.attachments).toEqual(['E-5-step-1.png', 'E-6-step-1.html']);
      expect(bug.links).toEqual(['https://eztest.example/ui/p/pay/runs/1']);
      expect(JSON.stringify(bug.description)).toContain('"type":"doc"'); // Atlassian Document Format on Cloud
      const second = await taggedRun([]);
      const [r2] = await runPublishers([spec], { run: second.run, runDir: second.dir, resolveSecret: secrets });
      expect(r2.message).toBe('0 bug(s) created, 1 existing bug(s) commented');
      expect(issues.filter((i) => i.labels.includes('eztest'))).toHaveLength(1);
      expect(bug.comments).toBe(1);
      // Only product bugs / unknowns are filed when triage classified the failure.
      const third = await taggedRun([]);
      const [r3] = await runPublishers([spec], { run: third.run, runDir: third.dir, resolveSecret: secrets, analysis: { triage: { verdicts: [{ journeyId: 'pay', category: 'environment', confidence: 0.9, reasons: [] }] } as never } });
      expect(r3.message).toBe('0 bug(s) created, 0 existing bug(s) commented');
    } finally {
      await srv.close();
    }
  });

  it('pulls requirements with JQL; those no journey covers are traceability gaps', async () => {
    const { srv } = await mockJira();
    try {
      const reqs = await jiraRequirements(new JiraClient({ baseUrl: srv.url, deployment: 'cloud', email: 'qa@example.com', apiToken: 'resolved-JIRA_TOKEN' }), 'project = PAY AND issuetype = Story');
      expect(reqs).toEqual([{ id: 'PAY-1', title: 'Pay by card', state: 'In Progress', source: 'jira', area: undefined }, { id: 'PAY-2', title: 'Refund', state: 'To Do', source: 'jira', area: undefined }]);
      const m = computeTraceability({ journeys: [{ id: 'pay', name: 'Pay', requirements: ['PAY-1'] }], latest: { pay: { status: 'passed', runId: 'r' } }, requirements: reqs });
      expect(m.rows.find((r) => r.requirement.id === 'PAY-2')).toMatchObject({ coverage: 'uncovered', gap: 'no journey traces to this requirement' });
      expect(m.rows.find((r) => r.requirement.id === 'PAY-1')?.coverage).toBe('covered-passing');
    } finally {
      await srv.close();
    }
  });

  it('Data Center uses API v2, a bearer PAT and plain-text descriptions', async () => {
    const dc = await startRecorder((r) => (r.path === '/rest/api/2/search' ? { body: { issues: [], total: 0 } } : r.path === '/rest/api/2/issue' ? { status: 201, body: { key: 'OPS-9' } } : { status: 201, body: {} }));
    try {
      const { dir, run } = await taggedRun([]);
      const [r] = await runPublishers([{ use: 'jira', baseUrl: dc.url, deployment: 'datacenter', token: 'secret://env/PAT', projectKey: 'OPS' }], { run, runDir: dir, resolveSecret: secrets });
      expect(r.ok).toBe(true);
      expect(dc.requests[0].headers.authorization).toBe('Bearer resolved-PAT');
      const create = dc.requests.find((q) => q.path === '/rest/api/2/issue')!;
      expect(typeof JSON.parse(create.body).fields.description).toBe('string');
    } finally {
      await dc.close();
    }
  });
});

describe('publishers in dry-run mode', () => {
  it('dry run: every publisher reports what it would send and sends nothing', async () => {
    const nothing = await startRecorder(() => ({ status: 500 }));
    try {
      await registerFirstPartyPlugins();
      const { dir, run } = await taggedRun([[], [], []]);
      const specs = [
        { use: 'jira', baseUrl: nothing.url, email: 'e', apiToken: 't', projectKey: 'PAY' },
        { use: 'slack', webhook: nothing.url },
        { use: 'teams', webhook: nothing.url },
      ];
      const res = await runPublishers(specs, { run, runDir: dir, resolveSecret: secrets, dryRun: true });
      expect(res.map((x) => [x.publisher, x.ok])).toEqual(specs.map((s) => [s.use, true]));
      expect(res.every((x) => /dry run/.test(x.message))).toBe(true);
      expect(nothing.requests).toHaveLength(0);
    } finally {
      await nothing.close();
    }
  });

  it('no test-management publisher is registered (Xray, Zephyr, TestRail, qTest, Octane)', async () => {
    await registerFirstPartyPlugins();
    const { dir, run } = await taggedRun([[], [], []]);
    for (const use of ['xray', 'zephyr', 'testrail', 'qtest', 'octane']) {
      const [r] = await runPublishers([{ use }], { run, runDir: dir, resolveSecret: secrets, dryRun: true });
      expect(r.ok, use).toBe(false);
    }
  });
});
