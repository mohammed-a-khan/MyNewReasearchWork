/** Mock GitHub, GitLab and Bitbucket REST APIs (the endpoints the providers call, their auth headers, paging and error shapes). */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface Req {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage['headers'];
  body?: unknown;
}

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

async function serve(handler: (req: Req, res: ServerResponse, base: string) => void | Promise<void>) {
  const reqs: Req[] = [];
  let base = '';
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const u = new URL(req.url ?? '/', 'http://x');
    const r: Req = { method: req.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    reqs.push(r);
    try {
      await handler(r, res, base);
    } catch (e) {
      send(res, 500, { message: String(e) });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: base, reqs, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Page an array with ?page=&per_page= and a Link header (GitHub / GitLab style). */
function linkPage<T>(res: ServerResponse, all: T[], r: Req, base: string, perPageDefault = 30) {
  const per = Math.min(Number(r.query.per_page ?? perPageDefault), 2); // tiny pages to exercise paging
  const page = Number(r.query.page ?? 1);
  const items = all.slice((page - 1) * per, page * per);
  const more = page * per < all.length;
  const q = new URLSearchParams({ ...r.query, page: String(page + 1) });
  send(res, 200, items, more ? { link: `<${base}${r.path}?${q}>; rel="next"` } : {});
}

export async function mockGitHub(token: string, o: { checksForbidden?: boolean } = {}) {
  const state = {
    checkRuns: [] as Array<{ id: number; name: string; head_sha: string; status: string; conclusion?: string; output: { title: string; summary: string; annotations: unknown[] }; annotationsSeen: unknown[] }>,
    statuses: [] as Array<{ sha: string; body: Record<string, unknown> }>,
    comments: new Map<number, Array<{ id: number; body: string }>>(),
    pulls: [] as Array<{ number: number; head: string; base: string; title: string; body: string; draft: boolean; html_url: string; reviewers: string[]; team_reviewers: string[] }>,
  };
  let id = 1000;
  const m = await serve((r, res, base) => {
    if (r.headers.authorization !== `Bearer ${token}`) return send(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
    if (r.headers['x-github-api-version'] !== '2022-11-28') return send(res, 400, { message: 'missing api version' });
    let x: RegExpExecArray | null;
    const P = '/repos/acme/shop';
    if ((x = new RegExp(`^${P}/commits/([0-9a-f]+)/check-runs$`).exec(r.path)) && r.method === 'GET') {
      if (o.checksForbidden) return send(res, 403, { message: 'Resource not accessible by personal access token' });
      const runs = state.checkRuns.filter((c) => c.head_sha === x![1] && (!r.query.check_name || c.name === r.query.check_name));
      return send(res, 200, { total_count: runs.length, check_runs: runs.map(({ annotationsSeen: _a, ...c }) => c) });
    }
    if (r.path === `${P}/check-runs` && r.method === 'POST') {
      if (o.checksForbidden) return send(res, 403, { message: 'Resource not accessible by personal access token' });
      const b = r.body as { name: string; head_sha: string; status: string; conclusion?: string; output: { title: string; summary: string; annotations: unknown[] } };
      if ((b.output.annotations ?? []).length > 50) return send(res, 422, { message: 'Validation Failed', errors: [{ field: 'annotations', code: 'too_many' }] });
      const c = { id: ++id, ...b, annotationsSeen: [...(b.output.annotations ?? [])] };
      state.checkRuns.push(c);
      return send(res, 201, c);
    }
    if ((x = new RegExp(`^${P}/check-runs/(\\d+)$`).exec(r.path)) && r.method === 'PATCH') {
      const c = state.checkRuns.find((y) => y.id === Number(x![1]));
      if (!c) return send(res, 404, { message: 'Not Found' });
      const b = r.body as { output?: { annotations?: unknown[] } };
      if ((b.output?.annotations ?? []).length > 50) return send(res, 422, { message: 'Validation Failed' });
      Object.assign(c, b);
      c.annotationsSeen.push(...(b.output?.annotations ?? []));
      return send(res, 200, c);
    }
    if ((x = new RegExp(`^${P}/statuses/([0-9a-f]+)$`).exec(r.path)) && r.method === 'POST') {
      state.statuses.push({ sha: x[1], body: r.body as Record<string, unknown> });
      return send(res, 201, { id: ++id, ...(r.body as object) });
    }
    if ((x = new RegExp(`^${P}/issues/(\\d+)/comments$`).exec(r.path))) {
      const list = state.comments.get(Number(x[1])) ?? [];
      state.comments.set(Number(x[1]), list);
      if (r.method === 'GET') return linkPage(res, list, r, base);
      if (r.method === 'POST') {
        const c = { id: ++id, body: (r.body as { body: string }).body };
        list.push(c);
        return send(res, 201, c);
      }
    }
    if ((x = new RegExp(`^${P}/issues/comments/(\\d+)$`).exec(r.path)) && r.method === 'PATCH') {
      for (const list of state.comments.values()) {
        const c = list.find((y) => y.id === Number(x![1]));
        if (c) {
          c.body = (r.body as { body: string }).body;
          return send(res, 200, c);
        }
      }
      return send(res, 404, { message: 'Not Found' });
    }
    if (r.path === `${P}/pulls`) {
      if (r.method === 'GET') return send(res, 200, state.pulls.filter((p) => `acme:${p.head}` === r.query.head));
      if (r.method === 'POST') {
        const b = r.body as { title: string; head: string; base: string; body: string; draft: boolean };
        if (state.pulls.some((p) => p.head === b.head)) return send(res, 422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] });
        const p = { number: ++id, ...b, html_url: `https://github.com/acme/shop/pull/${id}`, reviewers: [], team_reviewers: [] };
        state.pulls.push(p);
        return send(res, 201, p);
      }
    }
    if ((x = new RegExp(`^${P}/pulls/(\\d+)/requested_reviewers$`).exec(r.path)) && r.method === 'POST') {
      const p = state.pulls.find((y) => y.number === Number(x![1]))!;
      const b = r.body as { reviewers: string[]; team_reviewers: string[] };
      p.reviewers.push(...b.reviewers);
      p.team_reviewers.push(...b.team_reviewers);
      return send(res, 201, p);
    }
    send(res, 404, { message: `Not Found: ${r.method} ${r.path}` });
  });
  return { ...m, state };
}

export async function mockGitLab(token: string) {
  const PROJECT = encodeURIComponent('acme/web/shop');
  const state = {
    statuses: [] as Array<{ sha: string; query: Record<string, string> }>,
    notes: new Map<number, Array<{ id: number; body: string; system: boolean }>>(),
    discussions: new Map<number, Array<{ id: string; notes: Array<{ id: number; body: string; position?: unknown }> }>>(),
    mrs: [] as Array<{ iid: number; source_branch: string; target_branch: string; title: string; description: string; web_url: string; reviewer_ids: number[] }>,
    users: [{ id: 7, username: 'alice' }, { id: 8, username: 'bob', email: 'bob@contoso.com' }],
  };
  let id = 50;
  const m = await serve((r, res, base) => {
    if (r.headers['private-token'] !== token) return send(res, 401, { message: '401 Unauthorized' });
    let x: RegExpExecArray | null;
    const P = `/api/v4/projects/${PROJECT}`;
    if ((x = new RegExp(`^${P}/statuses/([0-9a-f]+)$`).exec(r.path)) && r.method === 'POST') {
      if (!['pending', 'running', 'success', 'failed', 'canceled'].includes(r.query.state)) return send(res, 400, { message: 'state is invalid' });
      state.statuses.push({ sha: x[1], query: r.query });
      return send(res, 201, { id: ++id, status: r.query.state, name: r.query.name });
    }
    if ((x = new RegExp(`^${P}/merge_requests/(\\d+)/notes(?:/(\\d+))?$`).exec(r.path))) {
      const list = state.notes.get(Number(x[1])) ?? [{ id: ++id, body: 'added 1 commit', system: true }];
      state.notes.set(Number(x[1]), list);
      if (r.method === 'GET') return linkPage(res, list, r, base);
      if (r.method === 'POST') {
        const n = { id: ++id, body: (r.body as { body: string }).body, system: false };
        list.push(n);
        return send(res, 201, n);
      }
      if (r.method === 'PUT' && x[2]) {
        const n = list.find((y) => y.id === Number(x![2]));
        if (!n) return send(res, 404, { message: '404 Not found' });
        n.body = (r.body as { body: string }).body;
        return send(res, 200, n);
      }
    }
    if ((x = new RegExp(`^${P}/merge_requests/(\\d+)/versions$`).exec(r.path))) return send(res, 200, [{ id: 1, base_commit_sha: 'b'.repeat(40), head_commit_sha: 'h'.repeat(40), start_commit_sha: 's'.repeat(40) }]);
    if ((x = new RegExp(`^${P}/merge_requests/(\\d+)/discussions(?:/([^/]+)/notes/(\\d+))?$`).exec(r.path))) {
      const list = state.discussions.get(Number(x[1])) ?? [];
      state.discussions.set(Number(x[1]), list);
      if (r.method === 'GET') return linkPage(res, list, r, base);
      if (r.method === 'POST') {
        const b = r.body as { body: string; position: { position_type: string; new_line: number; new_path: string; base_sha: string } };
        if (b.position?.position_type !== 'text' || !b.position.base_sha) return send(res, 400, { message: 'position is invalid' });
        const d = { id: `d${++id}`, notes: [{ id: ++id, body: b.body, position: b.position }] };
        list.push(d);
        return send(res, 201, d);
      }
      if (r.method === 'PUT' && x[2]) {
        const n = list.find((d) => d.id === x![2])?.notes.find((y) => y.id === Number(x![3]));
        if (!n) return send(res, 404, { message: '404 Not found' });
        n.body = (r.body as { body: string }).body;
        return send(res, 200, n);
      }
    }
    if (r.path === `${P}/merge_requests`) {
      if (r.method === 'GET') return send(res, 200, state.mrs.filter((y) => y.source_branch === r.query.source_branch));
      if (r.method === 'POST') {
        const b = r.body as { source_branch: string; target_branch: string; title: string; description: string; reviewer_ids?: number[] };
        const mr = { iid: ++id, ...b, web_url: `https://gitlab.com/acme/web/shop/-/merge_requests/${id}`, reviewer_ids: b.reviewer_ids ?? [] };
        state.mrs.push(mr);
        return send(res, 201, mr);
      }
    }
    if (r.path === '/api/v4/users' && r.method === 'GET') return send(res, 200, state.users.filter((u) => u.username === r.query.username || (r.query.search && u.email === r.query.search)));
    send(res, 404, { message: '404 Not Found' });
  });
  return { ...m, state };
}

export async function mockBitbucket(token: string) {
  const state = {
    statuses: [] as Array<{ sha: string; body: Record<string, unknown> }>,
    reports: new Map<string, { report: Record<string, unknown>; annotations: unknown[] }>(),
    comments: new Map<number, Array<{ id: number; content: { raw: string }; deleted: boolean }>>(),
    prs: [] as Array<{ id: number; title: string; source: { branch: { name: string } }; destination: { branch: { name: string } }; reviewers: unknown[]; state: string; links: { html: { href: string } } }>,
    members: [{ user: { nickname: 'alice', account_id: '557058:aaaa', display_name: 'Alice' } }, { user: { nickname: 'bob', account_id: '557058:bbbb', display_name: 'Bob' } }],
  };
  let id = 10;
  const m = await serve((r, res, base) => {
    if (r.headers.authorization !== `Bearer ${token}`) return send(res, 401, { type: 'error', error: { message: 'Token is invalid or not supported for this endpoint.' } });
    let x: RegExpExecArray | null;
    const P = '/2.0/repositories/acme/shop';
    const valuesPage = <T>(all: T[]) => {
      const page = Number(r.query.page ?? 1);
      const items = all.slice((page - 1) * 2, page * 2);
      send(res, 200, { pagelen: 2, page, size: all.length, values: items, ...(page * 2 < all.length ? { next: `${base}${r.path}?${new URLSearchParams({ ...r.query, page: String(page + 1) })}` } : {}) });
    };
    if ((x = new RegExp(`^${P}/commit/([0-9a-f]+)/statuses/build$`).exec(r.path)) && r.method === 'POST') {
      const b = r.body as Record<string, unknown>;
      if (!b.key || !b.url || !['SUCCESSFUL', 'FAILED', 'INPROGRESS', 'STOPPED'].includes(String(b.state))) return send(res, 400, { type: 'error', error: { message: 'key, state and url are required' } });
      state.statuses.push({ sha: x[1], body: b });
      return send(res, 201, b);
    }
    if ((x = new RegExp(`^${P}/commit/([0-9a-f]+)/reports/([^/]+)(/annotations)?$`).exec(r.path))) {
      const key = `${x[1]}:${x[2]}`;
      if (!x[3] && r.method === 'PUT') {
        state.reports.set(key, { report: r.body as Record<string, unknown>, annotations: [] });
        return send(res, 200, r.body);
      }
      if (x[3] && r.method === 'POST') {
        const rep = state.reports.get(key);
        if (!rep) return send(res, 404, { type: 'error', error: { message: 'report not found' } });
        if ((r.body as unknown[]).length > 100) return send(res, 400, { type: 'error', error: { message: 'max 100 annotations per request' } });
        rep.annotations.push(...(r.body as unknown[]));
        return send(res, 200, r.body);
      }
    }
    if ((x = new RegExp(`^${P}/pullrequests/(\\d+)/comments(?:/(\\d+))?$`).exec(r.path))) {
      const list = state.comments.get(Number(x[1])) ?? [];
      state.comments.set(Number(x[1]), list);
      if (r.method === 'GET') return valuesPage(list);
      if (r.method === 'POST') {
        const c = { id: ++id, content: { raw: (r.body as { content: { raw: string } }).content.raw }, deleted: false };
        list.push(c);
        return send(res, 201, c);
      }
      if (r.method === 'PUT') {
        const c = list.find((y) => y.id === Number(x![2]));
        if (!c) return send(res, 404, { type: 'error', error: { message: 'no comment' } });
        c.content.raw = (r.body as { content: { raw: string } }).content.raw;
        return send(res, 200, c);
      }
    }
    if (r.path === `${P}/pullrequests`) {
      if (r.method === 'GET') {
        const src = /source\.branch\.name="([^"]+)"/.exec(r.query.q ?? '')?.[1];
        return valuesPage(state.prs.filter((p) => p.source.branch.name === src && p.state === 'OPEN'));
      }
      if (r.method === 'POST') {
        const b = r.body as { title: string; source: { branch: { name: string } }; destination: { branch: { name: string } }; reviewers: unknown[] };
        const p = { id: ++id, ...b, state: 'OPEN', links: { html: { href: `https://bitbucket.org/acme/shop/pull-requests/${id}` } } };
        state.prs.push(p);
        return send(res, 201, p);
      }
    }
    if (r.path === '/2.0/workspaces/acme/members' && r.method === 'GET') return valuesPage(state.members);
    send(res, 404, { type: 'error', error: { message: `Resource not found: ${r.method} ${r.path}` } });
  });
  return { ...m, state };
}
