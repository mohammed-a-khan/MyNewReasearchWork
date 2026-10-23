/**
 * An in-memory Azure DevOps (Services or Server) for the integration tests:
 * every REST endpoint EZTest calls, with api-version checks (including
 * preview suffixes and an on-prem maximum version), PAT / bearer auth (and
 * the 203 sign-in page for a bad PAT), continuation-token paging, ADO's error
 * body shape, plus a mock Microsoft Entra ID token endpoint, an Azure
 * Pipelines OIDC endpoint (workload identity federation) and IMDS.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface MockWorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  relations: Array<{ rel: string; url: string; attributes?: Record<string, unknown> }>;
  comments: Array<{ id: number; text: string }>;
}

export interface MockRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  auth?: string;
  contentType?: string;
  body?: unknown;
}

export interface MockAdoOptions {
  pat?: string;
  /** Bearer tokens accepted as-is (e.g. a System.AccessToken). */
  bearer?: string[];
  /** Collection path, e.g. "/org" (Services) or "/tfs/DefaultCollection" (Server). */
  collectionPath?: string;
  project?: string;
  /** Highest api-version the server supports (Azure DevOps Server 2020 = 6.0). */
  maxApiVersion?: string;
  pageSize?: number;
  /** Federated identity the Entra mock accepts: tenant, client id, the OIDC subject and audience. */
  entra?: { tenantId: string; clientId: string; clientSecret?: string; subject?: string; audience?: string };
  /** Service connection id the pipeline OIDC endpoint issues tokens for. */
  serviceConnectionId?: string;
  /** Subject of the OIDC tokens the pipeline endpoint issues (default sc://org/proj/eztest-conn). */
  oidcSubject?: string;
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

const adoError = (res: ServerResponse, status: number, message: string, typeKey = 'VssServiceException') =>
  json(res, status, { $id: '1', innerException: null, message, typeName: `Microsoft.VisualStudio.Services.WebApi.${typeKey}, Microsoft.VisualStudio.Services.WebApi`, typeKey, errorCode: 0, eventId: 3000 });

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

/** An unsigned JWT-shaped token (the mock checks its claims, not a signature). */
export function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.sig`;
}

function claimsOf(t: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function cmpVersion(a: string, b: string): number {
  const [a1, a2] = a.split('.').map(Number);
  const [b1, b2] = b.split('.').map(Number);
  return a1 - b1 || a2 - b2;
}

export async function startMockAdoServer(o: MockAdoOptions = {}) {
  const pat = o.pat ?? 'mockPAT0123456789abcdef';
  const coll = o.collectionPath ?? '/org';
  const project = o.project ?? 'proj';
  const pageSize = o.pageSize ?? 2;
  const maxVer = o.maxApiVersion ?? '7.1';
  let nextId = 100;
  const id = () => ++nextId;
  const issued = new Set<string>();
  const state = {
    workItems: new Map<number, MockWorkItem>(),
    plans: new Map<number, { id: number; name: string }>(),
    suites: [] as Array<{ id: number; planId: number; name: string; suiteType: string; parentSuite?: { id: number }; queryString?: string; testCases: number[] }>,
    points: [] as Array<{ id: number; planId: number; suiteId: number; testCaseReference: { id: number }; configuration: { id: number; name: string } }>,
    configurations: [] as Array<{ id: number; name: string; isDefault?: boolean; state: string; values: Array<{ name: string; value: string }> }>,
    variables: [] as Array<{ id: number; name: string; values: string[] }>,
    runs: [] as Array<Record<string, unknown> & { id: number; name: string; state: string; plan: { id: string } }>,
    results: new Map<number, Array<Record<string, unknown> & { id: number }>>(),
    attachments: new Map<string, Array<{ id: number; fileName: string; size: number; iterationId?: string; actionPath?: string; comment?: string }>>(),
    flaky: [] as Array<{ testCaseReferenceId: number; body: unknown }>,
    savedQueries: new Map<string, { id: string; path: string; wiql: string }>(),
    repos: [] as Array<{ id: string; name: string }>,
    pullRequests: [] as Array<{ pullRequestId: number; repositoryId: string; sourceRefName: string; targetRefName: string; title: string; description: string; isDraft: boolean; status: string; reviewers: Array<{ id: string }> }>,
    prStatuses: [] as Array<{ repo: string; pr: number; body: Record<string, unknown> }>,
    commitStatuses: [] as Array<{ repo: string; sha: string; body: Record<string, unknown> }>,
    threads: new Map<string, Array<{ id: number; status: string; isDeleted: boolean; threadContext?: unknown; comments: Array<{ id: number; content: string; isDeleted: boolean }> }>>(),
    identities: [] as Array<{ id: string; providerDisplayName: string; filterValues: string[] }>,
    entraTokens: [] as string[],
    /** Builds: tags and associated work items (deployment test records). */
    buildTags: new Map<number, string[]>(),
    buildWorkItems: new Map<number, number[]>(),
  };
  const requests: MockRequest[] = [];
  const faults: { resultsPatch404?: boolean; flakyApi404?: boolean } = {};

  const wi = (type: string, fields: Record<string, unknown>, relations: MockWorkItem['relations'] = []): MockWorkItem => {
    const w: MockWorkItem = { id: id(), rev: 1, fields: { 'System.WorkItemType': type, 'System.State': type === 'Bug' ? 'Active' : 'Design', 'System.TeamProject': project, ...fields }, relations, comments: [] };
    state.workItems.set(w.id, w);
    return w;
  };

  const page = <T>(res: ServerResponse, all: T[], u: URL) => {
    const start = Number(u.searchParams.get('continuationToken') ?? 0);
    const items = all.slice(start, start + pageSize);
    const more = start + pageSize < all.length;
    json(res, 200, { value: items, count: items.length }, more ? { 'x-ms-continuationtoken': String(start + pageSize) } : {});
  };

  const read = async (req: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };

  const authOk = (h: string | undefined): 'ok' | 'bad-pat' | 'bad-bearer' | 'none' => {
    if (!h) return 'none';
    if (h.startsWith('Basic ')) return h === `Basic ${Buffer.from(':' + pat).toString('base64')}` ? 'ok' : 'bad-pat';
    if (h.startsWith('Bearer ')) {
      const t = h.slice(7);
      return (o.bearer ?? []).includes(t) || issued.has(t) ? 'ok' : 'bad-bearer';
    }
    return 'none';
  };

  /** Very small WIQL evaluator: WorkItemType =/IN, Tags CONTAINS, AreaPath UNDER, IterationPath UNDER, State NOT IN. */
  const wiql = (q: string): number[] => {
    const types = /\[System\.WorkItemType\]\s*=\s*'([^']+)'/i.exec(q)?.[1];
    const typeIn = /\[System\.WorkItemType\]\s+IN\s*\(([^)]*)\)/i.exec(q)?.[1]?.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    const tags = [...q.matchAll(/\[System\.Tags\]\s+CONTAINS\s+'([^']+)'/gi)].map((m) => m[1].replace(/''/g, "'"));
    const area = /\[System\.AreaPath\]\s+UNDER\s+'([^']+)'/i.exec(q)?.[1];
    const iter = /\[System\.IterationPath\]\s+UNDER\s+'([^']+)'/i.exec(q)?.[1];
    const notIn = /\[System\.State\]\s+NOT IN\s*\(([^)]*)\)/i.exec(q)?.[1]?.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    return [...state.workItems.values()]
      .filter((w) => {
        const f = w.fields;
        if (types && f['System.WorkItemType'] !== types) return false;
        if (typeIn && !typeIn.includes(String(f['System.WorkItemType']))) return false;
        const wt = String(f['System.Tags'] ?? '').split(';').map((t) => t.trim());
        if (tags.some((t) => !wt.includes(t))) return false;
        if (area && !String(f['System.AreaPath'] ?? '').startsWith(area)) return false;
        if (iter && !String(f['System.IterationPath'] ?? '').startsWith(iter)) return false;
        if (notIn && notIn.includes(String(f['System.State']))) return false;
        return true;
      })
      .map((w) => w.id)
      .sort((a, b) => a - b);
  };

  const applyPatch = (w: MockWorkItem, ops: Array<{ op: string; path: string; value: unknown }>) => {
    for (const op of ops) {
      if (op.path.startsWith('/fields/')) {
        if (op.op === 'remove') delete w.fields[op.path.slice(8)];
        else w.fields[op.path.slice(8)] = op.value;
      } else if (op.path === '/relations/-' && op.op === 'add') w.relations.push(op.value as MockWorkItem['relations'][number]);
    }
    w.rev++;
  };

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';
    const raw = method === 'GET' ? Buffer.alloc(0) : await read(req);
    const ct = String(req.headers['content-type'] ?? '');
    let body: unknown = undefined;
    if (raw.length) {
      if (/json/.test(ct)) body = JSON.parse(raw.toString('utf8'));
      else if (/x-www-form-urlencoded/.test(ct)) body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
      else body = raw;
    }
    const query = Object.fromEntries(u.searchParams);
    requests.push({ method, path: u.pathname, query, auth: req.headers.authorization, contentType: ct, body });
    const path = u.pathname;
    let m: RegExpExecArray | null;

    // ------------------------------------------------------------ identity providers (no ADO auth)
    if ((m = /^\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(path)) && method === 'POST') {
      const f = body as Record<string, string>;
      const e = o.entra;
      if (!e || m[1] !== e.tenantId) return json(res, 400, { error: 'invalid_request', error_description: `AADSTS90002: Tenant '${m[1]}' not found.` });
      if (f.grant_type !== 'client_credentials' || f.client_id !== e.clientId) return json(res, 400, { error: 'unauthorized_client', error_description: 'AADSTS700016: Application not found in the directory.' });
      if (f.scope !== '499b84ac-1321-427f-aa17-267ca6975798/.default') return json(res, 400, { error: 'invalid_scope', error_description: 'AADSTS70011: The provided value for scope is not valid.' });
      if (f.client_assertion) {
        const c = claimsOf(f.client_assertion);
        if (f.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') return json(res, 400, { error: 'invalid_request', error_description: 'AADSTS50027: bad assertion type' });
        if (!c || c.sub !== (e.subject ?? 'sc://org/proj/eztest-conn') || c.aud !== (e.audience ?? 'api://AzureADTokenExchange')) return json(res, 401, { error: 'invalid_client', error_description: `AADSTS700213: No matching federated identity record found for presented assertion subject '${c?.sub}'.` });
        if (typeof c.exp === 'number' && c.exp * 1000 < Date.now()) return json(res, 401, { error: 'invalid_client', error_description: 'AADSTS700024: Client assertion is not within its valid time range.' });
      } else if (!e.clientSecret || f.client_secret !== e.clientSecret) return json(res, 401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
      const tok = fakeJwt({ aud: '499b84ac-1321-427f-aa17-267ca6975798', appid: e.clientId, n: id() });
      issued.add(tok);
      state.entraTokens.push(tok);
      return json(res, 200, { token_type: 'Bearer', expires_in: 3599, ext_expires_in: 3599, access_token: tok });
    }
    if (path === '/oidc' && method === 'POST') {
      // Azure Pipelines System.OidcRequestUri: needs System.AccessToken and the service connection id.
      if (u.searchParams.get('api-version') !== '7.1') return adoError(res, 400, 'api-version is required');
      if (authOk(req.headers.authorization) !== 'ok') return adoError(res, 401, 'TF400813: The user is not authorized to access this resource.');
      if (u.searchParams.get('serviceConnectionId') !== (o.serviceConnectionId ?? 'conn-1')) return adoError(res, 404, 'Service connection not found');
      const now = Math.floor(Date.now() / 1000);
      return json(res, 200, { oidcToken: fakeJwt({ iss: 'https://vstoken.dev.azure.com/org-guid', sub: o.oidcSubject ?? 'sc://org/proj/eztest-conn', aud: 'api://AzureADTokenExchange', iat: now, exp: now + 600 }) });
    }
    if (path === '/metadata/identity/oauth2/token' && method === 'GET') {
      if (req.headers.metadata !== 'true') return json(res, 400, { error: 'invalid_request', error_description: 'Required metadata header not specified' });
      if (u.searchParams.get('resource') !== '499b84ac-1321-427f-aa17-267ca6975798') return json(res, 400, { error: 'invalid_resource' });
      const tok = fakeJwt({ mi: true, n: id() });
      issued.add(tok);
      return json(res, 200, { access_token: tok, expires_on: String(Math.floor(Date.now() / 1000) + 3600), resource: u.searchParams.get('resource'), token_type: 'Bearer' });
    }

    // ------------------------------------------------------------ ADO auth and api-version
    const a = authOk(req.headers.authorization);
    if (a === 'bad-pat' || a === 'none') {
      res.writeHead(203, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<html><head><title>Sign In</title></head><body>Azure DevOps Services | Sign In</body></html>');
    }
    if (a === 'bad-bearer') return adoError(res, 401, 'TF400813: The user is not authorized to access this resource.', 'UnauthorizedRequestException');
    const ver = u.searchParams.get('api-version');
    if (!ver) return adoError(res, 400, 'No api-version was supplied for the request.', 'VssVersionNotSpecifiedException');
    const [base, preview] = ver.split('-');
    if (cmpVersion(base, maxVer) > 0) return adoError(res, 400, `The requested REST API version of ${ver} is out of range for this server. The latest REST API version for this server is ${maxVer}.`, 'VssVersionOutOfRangeException');
    const needsPreview = (want: string) => {
      if (preview !== want) {
        adoError(res, 400, `The requested version "${ver}" of the resource is under preview. The -preview flag must be supplied in the api-version for such requests. For example: "${base}-${want}"`, 'VssInvalidPreviewVersionException');
        return true;
      }
      return false;
    };
    const P = `${coll}/${project}`;
    if (!path.startsWith(coll)) return adoError(res, 404, `mock: unknown collection ${path}`);

    // ------------------------------------------------------------ collection level
    if (path === `${coll}/_apis/connectionData` && method === 'GET') return json(res, 200, { authenticatedUser: { id: 'u-1', providerDisplayName: 'EZTest Bot' }, authorizedUser: { id: 'u-1' } });
    if (path === `${coll}/_apis/identities` && method === 'GET') {
      const v = (u.searchParams.get('filterValue') ?? '').toLowerCase();
      const hits = state.identities.filter((i) => i.filterValues.some((f) => f.toLowerCase() === v));
      return json(res, 200, { count: hits.length, value: hits.map((h) => ({ id: h.id, providerDisplayName: h.providerDisplayName })) });
    }
    if (!path.startsWith(P + '/')) return adoError(res, 404, `mock: unknown project path ${path}`);
    const p = path.slice(P.length);

    // ------------------------------------------------------------ work items
    if (p === '/_apis/wit/workitemsbatch' && method === 'POST') {
      const b = body as { ids: number[]; fields?: string[]; $expand?: string };
      if (b.fields && b.$expand) return adoError(res, 400, 'The expand parameter can not be used with the fields parameter.');
      const value = b.ids.map((i) => state.workItems.get(i)).filter(Boolean).map((w) => ({
        id: w!.id,
        rev: w!.rev,
        fields: b.fields ? Object.fromEntries(b.fields.filter((f) => f in w!.fields).map((f) => [f, w!.fields[f]])) : { ...w!.fields },
        ...(b.$expand?.toLowerCase() === 'relations' ? { relations: w!.relations } : {}),
      }));
      return json(res, 200, { count: value.length, value });
    }
    if (p === '/_apis/wit/wiql' && method === 'POST') {
      const ids = wiql((body as { query: string }).query);
      return json(res, 200, { queryType: 'flat', workItems: ids.map((i) => ({ id: i, url: `x/${i}` })) });
    }
    if ((m = /^\/_apis\/wit\/wiql\/([0-9a-f-]{36})$/i.exec(p)) && method === 'GET') {
      const q = [...state.savedQueries.values()].find((x) => x.id === m![1]);
      if (!q) return adoError(res, 404, 'TF401243: The query does not exist');
      return json(res, 200, { workItems: wiql(q.wiql).map((i) => ({ id: i })) });
    }
    if ((m = /^\/_apis\/wit\/queries\/(.+)$/i.exec(p)) && method === 'GET') {
      const q = state.savedQueries.get(decodeURIComponent(m[1]));
      return q ? json(res, 200, { id: q.id, path: q.path }) : adoError(res, 404, 'TF401243: The query does not exist');
    }
    if ((m = /^\/_apis\/wit\/workitems\/\$(.+)$/i.exec(p)) && method === 'POST') {
      if (ct !== 'application/json-patch+json') return adoError(res, 415, 'json-patch required');
      const ops = body as Array<{ op: string; path: string; value: unknown }>;
      if (!ops.some((x) => x.path === '/fields/System.Title')) return adoError(res, 400, 'TF401320: Rule Error for field Title. Error code: Required, InvalidEmpty.');
      const w = wi(decodeURIComponent(m[1]), {});
      w.rev = 0;
      applyPatch(w, ops);
      return json(res, 200, { id: w.id, rev: w.rev, fields: w.fields, relations: w.relations });
    }
    if ((m = /^\/_apis\/wit\/workitems\/(\d+)$/i.exec(p)) && method === 'PATCH') {
      const w = state.workItems.get(Number(m[1]));
      if (!w) return adoError(res, 404, `TF401232: Work item ${m[1]} does not exist`);
      if (ct !== 'application/json-patch+json') return adoError(res, 415, 'json-patch required');
      applyPatch(w, body as Array<{ op: string; path: string; value: unknown }>);
      return json(res, 200, { id: w.id, rev: w.rev, fields: w.fields });
    }
    if ((m = /^\/_apis\/wit\/workItems\/(\d+)\/comments(?:\/(\d+))?$/i.exec(p))) {
      if (needsPreview('preview.4')) return;
      const w = state.workItems.get(Number(m[1]));
      if (!w) return adoError(res, 404, 'work item not found');
      if (method === 'GET') return json(res, 200, { totalCount: w.comments.length, count: w.comments.length, comments: w.comments });
      if (method === 'POST') {
        const c = { id: id(), text: (body as { text: string }).text };
        w.comments.push(c);
        return json(res, 200, c);
      }
      if (method === 'PATCH' && m[2]) {
        const c = w.comments.find((x) => x.id === Number(m![2]));
        if (!c) return adoError(res, 404, 'comment not found');
        c.text = (body as { text: string }).text;
        return json(res, 200, c);
      }
    }
    if (p === '/_apis/wit/attachments' && method === 'POST') return json(res, 200, { id: `att-${id()}`, url: `http://127.0.0.1/_apis/wit/attachments/${u.searchParams.get('fileName')}` });

    // ------------------------------------------------------------ test plans
    if ((m = /^\/_apis\/testplan\/Plans\/(\d+)\/suites(?:\/(\d+))?$/i.exec(p))) {
      const planId = Number(m[1]);
      if (!state.plans.has(planId)) return adoError(res, 404, `Test plan ${planId} not found`, 'TestObjectNotFoundException');
      if (method === 'GET' && !m[2]) return page(res, state.suites.filter((s) => s.planId === planId).map(({ testCases: _t, ...s }) => s), u);
      if (method === 'POST') {
        const b = body as { suiteType: string; name: string; parentSuite: { id: number }; queryString?: string };
        const s = { id: id(), planId, name: b.name, suiteType: b.suiteType, parentSuite: b.parentSuite, ...(b.queryString ? { queryString: b.queryString } : {}), testCases: [] as number[] };
        state.suites.push(s);
        const { testCases: _t, ...out } = s;
        return json(res, 200, out);
      }
      if (method === 'PATCH' && m[2]) {
        const s = state.suites.find((x) => x.id === Number(m![2]));
        if (!s) return adoError(res, 404, 'suite not found');
        Object.assign(s, body as object);
        const { testCases: _t, ...out } = s;
        return json(res, 200, out);
      }
    }
    if ((m = /^\/_apis\/testplan\/Plans\/(\d+)\/Suites\/(\d+)\/TestCase$/i.exec(p))) {
      const s = state.suites.find((x) => x.id === Number(m![2]) && x.planId === Number(m![1]));
      if (!s) return adoError(res, 404, `Suite ${m[2]} not found`, 'TestObjectNotFoundException');
      const ids = s.suiteType === 'dynamicTestSuite' ? wiql(s.queryString ?? '') : s.testCases;
      if (method === 'GET') return page(res, ids.map((i) => ({ workItem: { id: i, name: String(state.workItems.get(i)?.fields['System.Title'] ?? '') }, pointAssignments: state.points.filter((x) => x.suiteId === s.id && x.testCaseReference.id === i).map((x) => ({ id: x.id, configurationId: x.configuration.id })) })), u);
      if (method === 'POST') {
        if (s.suiteType !== 'staticTestSuite') return adoError(res, 400, 'Test cases can only be added to static suites');
        const added = [];
        for (const it of body as Array<{ workItem: { id: number }; pointAssignments?: Array<{ configurationId: number }> }>) {
          if (!state.workItems.has(it.workItem.id)) return adoError(res, 404, `Test case ${it.workItem.id} not found`);
          if (!s.testCases.includes(it.workItem.id)) s.testCases.push(it.workItem.id);
          const cfgs = it.pointAssignments?.map((x) => x.configurationId) ?? [state.configurations.find((c) => c.isDefault)?.id ?? 1];
          for (const cid of cfgs) {
            const cfg = state.configurations.find((c) => c.id === cid) ?? { id: cid, name: `Config ${cid}` };
            state.points.push({ id: id(), planId: s.planId, suiteId: s.id, testCaseReference: { id: it.workItem.id }, configuration: { id: cfg.id, name: cfg.name } });
          }
          added.push({ workItem: { id: it.workItem.id } });
        }
        return json(res, 200, { value: added, count: added.length });
      }
      if (method === 'DELETE') {
        const rm = (u.searchParams.get('testIds') ?? '').split(',').map(Number);
        s.testCases = s.testCases.filter((x) => !rm.includes(x));
        state.points = state.points.filter((x) => !(x.suiteId === s.id && rm.includes(x.testCaseReference.id)));
        return json(res, 204, undefined);
      }
    }
    if ((m = /^\/_apis\/testplan\/Plans\/(\d+)\/Suites\/(\d+)\/TestPoint$/i.exec(p)) && method === 'GET') {
      return page(res, state.points.filter((x) => x.planId === Number(m![1]) && x.suiteId === Number(m![2])).map(({ planId: _p, suiteId: _s, ...x }) => x), u);
    }
    if (p === '/_apis/testplan/configurations') {
      if (method === 'GET') return page(res, state.configurations, u);
      if (method === 'POST') {
        const b = body as { name: string; values: Array<{ name: string; value: string }> };
        for (const v of b.values ?? []) {
          const tv = state.variables.find((x) => x.name === v.name);
          if (!tv || !tv.values.includes(v.value)) return adoError(res, 400, `Test variable ${v.name} has no value ${v.value}`);
        }
        const c = { id: id(), name: b.name, state: 'active', values: b.values ?? [] };
        state.configurations.push(c);
        return json(res, 200, c);
      }
    }
    if ((m = /^\/_apis\/testplan\/variables(?:\/(\d+))?$/i.exec(p))) {
      if (method === 'GET' && !m[1]) return page(res, state.variables, u);
      if (method === 'POST') {
        const v = { id: id(), ...(body as { name: string; values: string[] }) };
        state.variables.push(v);
        return json(res, 200, v);
      }
      if (method === 'PATCH' && m[1]) {
        const v = state.variables.find((x) => x.id === Number(m![1]));
        if (!v) return adoError(res, 404, 'variable not found');
        Object.assign(v, body as object);
        return json(res, 200, v);
      }
    }

    // ------------------------------------------------------------ test runs and results
    if (p === '/_apis/test/runs') {
      if (method === 'GET') return json(res, 200, { value: state.runs.filter((r) => r.plan.id === u.searchParams.get('planId')) });
      if (method === 'POST') {
        const b = body as Record<string, unknown> & { name: string; state: string; plan: { id: string } };
        const run = { ...b, id: id() };
        state.runs.push(run);
        state.results.set(run.id, []);
        return json(res, 200, run);
      }
    }
    if ((m = /^\/_apis\/test\/runs\/(\d+)$/i.exec(p)) && method === 'PATCH') {
      const run = state.runs.find((r) => r.id === Number(m![1]));
      if (!run) return adoError(res, 404, 'run not found');
      Object.assign(run, body as object);
      return json(res, 200, run);
    }
    if ((m = /^\/_apis\/test\/Runs\/(\d+)\/results$/i.exec(p))) {
      const list = state.results.get(Number(m[1]));
      if (!list) return adoError(res, 404, 'run not found');
      if (method === 'GET') {
        const skip = Number(u.searchParams.get('$skip') ?? 0);
        const top = Number(u.searchParams.get('$top') ?? 1000);
        return json(res, 200, { value: list.slice(skip, skip + top) });
      }
      if (method === 'POST') {
        if (!Array.isArray(body) || body.length > 100) return adoError(res, 400, 'at most 100 results per request');
        const created = (body as Array<Record<string, unknown>>).map((r) => ({ ...r, id: id(), testCaseReferenceId: 9000 + Number((r.testCase as { id: string }).id) }));
        list.push(...created);
        return json(res, 200, { value: created, count: created.length });
      }
      if (method === 'PATCH') {
        if (faults.resultsPatch404) return adoError(res, 404, 'not supported');
        for (const upd of body as Array<Record<string, unknown> & { id: number }>) {
          const r = list.find((x) => x.id === upd.id);
          if (!r) return adoError(res, 404, `result ${upd.id} not found`);
          Object.assign(r, upd);
        }
        return json(res, 200, { value: body });
      }
    }
    if ((m = /^\/_apis\/test\/Runs\/(\d+)(?:\/Results\/(\d+))?\/attachments$/i.exec(p))) {
      const key = `${m[1]}:${m[2] ?? ''}`;
      const list = state.attachments.get(key) ?? [];
      state.attachments.set(key, list);
      if (method === 'GET') return json(res, 200, { value: list });
      if (method === 'POST') {
        const b = body as { stream: string; fileName: string; comment?: string };
        const att = { id: id(), fileName: b.fileName, size: Buffer.from(b.stream, 'base64').length, comment: b.comment, ...(u.searchParams.get('iterationId') ? { iterationId: u.searchParams.get('iterationId')! } : {}), ...(u.searchParams.get('actionPath') ? { actionPath: u.searchParams.get('actionPath')! } : {}) };
        list.push(att);
        return json(res, 200, { id: att.id, url: `http://x/att/${att.id}` });
      }
    }
    if ((m = /^\/_apis\/testresults\/results\/resultmetadata\/(\d+)$/i.exec(p)) && method === 'PATCH') {
      if (needsPreview('preview.4')) return;
      if (faults.flakyApi404) return adoError(res, 404, 'API resource location not found');
      state.flaky.push({ testCaseReferenceId: Number(m[1]), body });
      return json(res, 200, { testCaseReferenceId: Number(m[1]), ...(body as object) });
    }

    // ------------------------------------------------------------ builds (tags, associated work items)
    if ((m = /^\/_apis\/build\/builds\/(\d+)\/tags\/([^/]+)$/i.exec(p)) && method === 'PUT') {
      const list = state.buildTags.get(Number(m[1])) ?? [];
      const tag = decodeURIComponent(m[2]);
      if (!list.includes(tag)) list.push(tag);
      state.buildTags.set(Number(m[1]), list);
      return json(res, 200, { count: list.length, value: list });
    }
    if ((m = /^\/_apis\/build\/builds\/(\d+)\/workitems$/i.exec(p)) && method === 'GET') {
      const ids = state.buildWorkItems.get(Number(m[1])) ?? [];
      return json(res, 200, { count: ids.length, value: ids.map((i) => ({ id: String(i), url: `http://x/_apis/wit/workItems/${i}` })) });
    }

    // ------------------------------------------------------------ git
    if ((m = /^\/_apis\/git\/repositories\/([^/]+)$/i.exec(p)) && method === 'GET') {
      const r = state.repos.find((x) => x.name === decodeURIComponent(m![1]) || x.id === m![1]);
      return r ? json(res, 200, r) : adoError(res, 404, `TF401019: The Git repository with name or identifier ${m[1]} does not exist`, 'GitRepositoryNotFoundException');
    }
    if ((m = /^\/_apis\/git\/repositories\/([^/]+)\/(.*)$/i.exec(p))) {
      const repo = state.repos.find((x) => x.id === m![1]);
      if (!repo) return adoError(res, 404, 'repository not found');
      const rest = m[2];
      let k: RegExpExecArray | null;
      if ((k = /^pullRequests\/(\d+)\/statuses$/i.exec(rest)) && method === 'POST') {
        if (needsPreview('preview.1')) return;
        const b = body as Record<string, unknown>;
        if (!['succeeded', 'failed', 'pending', 'error', 'notSet', 'notApplicable'].includes(String(b.state))) return adoError(res, 400, 'invalid state');
        state.prStatuses.push({ repo: repo.id, pr: Number(k[1]), body: b });
        return json(res, 200, { id: state.prStatuses.length, ...b });
      }
      if ((k = /^commits\/([0-9a-f]+)\/statuses$/i.exec(rest)) && method === 'POST') {
        state.commitStatuses.push({ repo: repo.id, sha: k[1], body: body as Record<string, unknown> });
        return json(res, 200, { id: state.commitStatuses.length, ...(body as object) });
      }
      if ((k = /^pullRequests\/(\d+)\/threads(?:\/(\d+))?(?:\/comments\/(\d+))?$/i.exec(rest))) {
        const key = `${repo.id}:${k[1]}`;
        const threads = state.threads.get(key) ?? [];
        state.threads.set(key, threads);
        if (method === 'GET' && !k[2]) return json(res, 200, { value: threads, count: threads.length });
        if (method === 'POST' && !k[2]) {
          const b = body as { comments: Array<{ content: string }>; status: string; threadContext?: unknown };
          const t = { id: id(), status: b.status, isDeleted: false, ...(b.threadContext ? { threadContext: b.threadContext } : {}), comments: b.comments.map((c) => ({ id: id(), content: c.content, isDeleted: false })) };
          threads.push(t);
          return json(res, 200, t);
        }
        const t = threads.find((x) => x.id === Number(k![2]));
        if (!t) return adoError(res, 404, 'thread not found');
        if (method === 'PATCH' && k[3]) {
          const c = t.comments.find((x) => x.id === Number(k![3]));
          if (!c) return adoError(res, 404, 'comment not found');
          c.content = (body as { content: string }).content;
          return json(res, 200, c);
        }
        if (method === 'PATCH') {
          Object.assign(t, body as object);
          return json(res, 200, t);
        }
      }
      if (/^pullrequests$/i.test(rest)) {
        if (method === 'GET') {
          const src = u.searchParams.get('searchCriteria.sourceRefName');
          const st = u.searchParams.get('searchCriteria.status');
          return json(res, 200, { value: state.pullRequests.filter((x) => x.repositoryId === repo.id && (!src || x.sourceRefName === src) && (!st || x.status === st)) });
        }
        if (method === 'POST') {
          const b = body as { sourceRefName: string; targetRefName: string; title: string; description: string; isDraft: boolean; reviewers: Array<{ id: string }> };
          if (state.pullRequests.some((x) => x.repositoryId === repo.id && x.sourceRefName === b.sourceRefName && x.status === 'active')) return adoError(res, 409, 'TF401179: An active pull request for the source and target branch already exists.', 'GitPullRequestExistsException');
          const pr = { pullRequestId: id(), repositoryId: repo.id, status: 'active', ...b };
          state.pullRequests.push(pr);
          return json(res, 201, pr);
        }
      }
    }
    adoError(res, 404, `mock: no route ${method} ${path}`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    collectionUrl: `${url}${coll}`,
    project,
    pat,
    state,
    requests,
    faults,
    /** Seed helpers. */
    workItem: wi,
    plan(name = 'Plan'): { planId: number; rootSuiteId: number } {
      const planId = id();
      state.plans.set(planId, { id: planId, name });
      const root = { id: id(), planId, name, suiteType: 'staticTestSuite', testCases: [] as number[] };
      state.suites.push(root);
      return { planId, rootSuiteId: root.id };
    },
    suite(planId: number, parent: number, name: string, testCases: number[] = [], configurationIds?: number[]): number {
      const s = { id: id(), planId, name, suiteType: 'staticTestSuite', parentSuite: { id: parent }, testCases: [...testCases] };
      state.suites.push(s);
      for (const tc of testCases) {
        for (const cid of configurationIds ?? [state.configurations[0]?.id ?? 1]) {
          const cfg = state.configurations.find((c) => c.id === cid) ?? { id: cid, name: `Config ${cid}` };
          state.points.push({ id: id(), planId, suiteId: s.id, testCaseReference: { id: tc }, configuration: { id: cfg.id, name: cfg.name } });
        }
      }
      return s.id;
    },
    configuration(name: string, values: Array<{ name: string; value: string }> = [], isDefault = false): number {
      const c = { id: id(), name, state: 'active', values, isDefault };
      state.configurations.push(c);
      return c.id;
    },
    repo(name: string): string {
      const r = { id: `repo-${id()}`, name };
      state.repos.push(r);
      return r.id;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export type MockAdoServer = Awaited<ReturnType<typeof startMockAdoServer>>;
