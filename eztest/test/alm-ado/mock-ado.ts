/** A small in-memory Azure DevOps server for publishRun tests. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface MockAdo {
  url: string;
  close(): Promise<void>;
  requests: Array<{ method: string; path: string; auth?: string; body?: unknown }>;
  state: {
    points: Record<string, Array<{ id: number; testCaseReference: { id: number } }>>;
    runs: Array<{ id: number; name: string; state: string; plan: string }>;
    results: Record<number, Array<Record<string, unknown> & { id: number }>>;
    attachments: Record<string, Array<{ id: number; fileName: string; size: number }>>;
    bugs: Array<{ id: number; tags: string; state: string; title: string; relations: unknown[]; repro: string }>;
  };
  faults: {
    pointsRateLimitOnce?: boolean;
    createRunCommitThen500?: boolean;
    resultsCommitThen503?: boolean;
    bugFailOnce503?: boolean;
    alwaysHtmlForGet?: boolean;
  };
}

export async function startMockAdo(pat: string, pageSize = 2): Promise<MockAdo> {
  const expected = `Basic ${Buffer.from(':' + pat).toString('base64')}`;
  let nextId = 1000;
  const mock: Omit<MockAdo, 'url' | 'close'> = {
    requests: [],
    state: { points: {}, runs: [], results: {}, attachments: {}, bugs: [] },
    faults: {},
  };
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  };
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const t = Buffer.concat(chunks).toString('utf8');
    return t ? JSON.parse(t) : undefined;
  };
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const path = u.pathname;
    const method = req.method ?? 'GET';
    const body = method === 'GET' ? undefined : await read(req);
    mock.requests.push({ method, path: path + u.search, auth: req.headers.authorization, body });
    if (req.headers.authorization !== expected || (mock.faults.alwaysHtmlForGet && method === 'GET')) {
      res.writeHead(203, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body>Sign In - Azure DevOps</body></html>');
      return;
    }
    if (u.searchParams.get('api-version') !== '7.1') return json(res, 400, { message: 'api-version missing' });
    const p = path.replace(/^\/org\/proj/, '');
    let m: RegExpExecArray | null;

    if ((m = /^\/_apis\/testplan\/Plans\/(\d+)\/Suites\/(\d+)\/TestPoint$/i.exec(p)) && method === 'GET') {
      if (mock.faults.pointsRateLimitOnce) {
        mock.faults.pointsRateLimitOnce = false;
        return json(res, 429, { message: 'TF400733: request was blocked' }, { 'retry-after': '2' });
      }
      const all = mock.state.points[`${m[1]}:${m[2]}`] ?? [];
      const start = Number(u.searchParams.get('continuationToken') ?? 0);
      const page = all.slice(start, start + pageSize);
      const more = start + pageSize < all.length;
      return json(res, 200, { value: page, count: page.length }, more ? { 'x-ms-continuationtoken': String(start + pageSize) } : {});
    }
    if (/^\/_apis\/test\/runs$/i.test(p)) {
      if (method === 'GET') return json(res, 200, { value: mock.state.runs.filter((r) => r.plan === u.searchParams.get('planId')) });
      if (method === 'POST') {
        const run = { id: ++nextId, name: body.name, state: body.state, plan: body.plan.id };
        mock.state.runs.push(run);
        mock.state.results[run.id] = [];
        if (mock.faults.createRunCommitThen500) {
          mock.faults.createRunCommitThen500 = false;
          return json(res, 500, { message: 'internal error after commit' });
        }
        return json(res, 200, run);
      }
    }
    if ((m = /^\/_apis\/test\/runs\/(\d+)$/i.exec(p)) && method === 'PATCH') {
      const run = mock.state.runs.find((r) => r.id === Number(m![1]));
      if (!run) return json(res, 404, { message: 'no run' });
      run.state = body.state;
      return json(res, 200, run);
    }
    if ((m = /^\/_apis\/test\/Runs\/(\d+)\/results$/i.exec(p))) {
      const list = mock.state.results[Number(m[1])];
      if (!list) return json(res, 404, { message: 'no run' });
      if (method === 'GET') {
        const skip = Number(u.searchParams.get('$skip') ?? 0);
        const top = Number(u.searchParams.get('$top') ?? 1000);
        return json(res, 200, { value: list.slice(skip, skip + top) });
      }
      if (method === 'POST') {
        if (!Array.isArray(body) || body.length > 100) return json(res, 400, { message: 'bad batch' });
        const created = body.map((r: Record<string, unknown>) => ({ ...r, id: ++nextId }));
        list.push(...created);
        if (mock.faults.resultsCommitThen503) {
          mock.faults.resultsCommitThen503 = false;
          return json(res, 503, { message: 'service unavailable' });
        }
        return json(res, 200, { value: created, count: created.length });
      }
    }
    if ((m = /^\/_apis\/test\/Runs\/(\d+)(?:\/Results\/(\d+))?\/attachments$/i.exec(p))) {
      const key = `${m[1]}:${m[2] ?? ''}`;
      mock.state.attachments[key] ??= [];
      if (method === 'GET') return json(res, 200, { value: mock.state.attachments[key] });
      if (method === 'POST') {
        const a = { id: ++nextId, fileName: body.fileName, size: Buffer.from(body.stream, 'base64').length };
        mock.state.attachments[key].push(a);
        return json(res, 200, { id: a.id, url: `http://x/att/${a.id}` });
      }
    }
    if (/^\/_apis\/wit\/wiql$/i.test(p) && method === 'POST') {
      const tag = /CONTAINS '([^']+)'/.exec(body.query)?.[1];
      const hits = mock.state.bugs.filter((b) => b.state === 'Active' && tag && b.tags.split('; ').includes(tag));
      return json(res, 200, { workItems: hits.map((b) => ({ id: b.id })) });
    }
    if (/^\/_apis\/wit\/workitems\/\$Bug$/i.test(p) && method === 'POST') {
      if (req.headers['content-type'] !== 'application/json-patch+json') return json(res, 415, { message: 'json-patch required' });
      if (mock.faults.bugFailOnce503) {
        mock.faults.bugFailOnce503 = false;
        return json(res, 503, { message: 'try later' });
      }
      const field = (n: string) => body.find((o: { path: string }) => o.path === `/fields/${n}`)?.value;
      const bug = {
        id: ++nextId,
        tags: field('System.Tags'),
        title: field('System.Title'),
        repro: field('Microsoft.VSTS.TCM.ReproSteps'),
        state: 'Active',
        relations: body.filter((o: { path: string }) => o.path === '/relations/-').map((o: { value: unknown }) => o.value),
      };
      mock.state.bugs.push(bug);
      return json(res, 200, { id: bug.id });
    }
    json(res, 404, { message: `mock: no route ${method} ${p}` });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return { ...mock, url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) } as MockAdo;
}
