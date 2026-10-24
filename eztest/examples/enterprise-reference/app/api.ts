/**
 * The Larkspur API gateway: OAuth2 client credentials, the REST API (v1),
 * GraphQL and the OpenAPI document. Partners (brokers, reporting) use it.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { batchRun, BATCH_JOB, startBatch } from './batch.ts';
import { hashPassword, type Row } from './db.ts';
import { executeGraphQL, type Resolved } from './graphql.ts';
import { HttpError, json, readBody, readJson, send } from './http.ts';
import type { Services } from './services.ts';
import { ROOT } from './settings.ts';

interface Token {
  client: string;
  scopes: Set<string>;
  expires: number;
}

export const claimJson = (svc: Services, c: Row, withDocs = true) => ({
  claimId: c.id,
  policyId: c.policy_id,
  customerId: c.customer_id,
  type: c.type,
  channel: c.channel,
  incidentDate: c.incident_date,
  reportedAt: c.reported_at,
  description: c.description,
  amountClaimed: c.amount_claimed,
  status: c.status,
  priority: c.priority,
  lateNotification: c.late_notification === 1,
  approvedAmount: c.approved_amount ?? null,
  payoutAmount: c.payout_amount ?? null,
  decisionReason: c.decision_reason ?? null,
  externalRef: c.external_ref ?? null,
  updatedAt: c.updated_at,
  ...(withDocs ? { documents: svc.claimDocuments(String(c.id)).map((d) => ({ filename: d.filename, contentType: d.content_type, size: d.size, sha256: d.sha256 })) } : {}),
});

const policyJson = (p: Row) => ({
  policyId: p.id,
  customerId: p.customer_id,
  product: p.product,
  status: p.status,
  sumInsured: p.sum_insured,
  deductible: p.deductible,
  region: p.region,
  startDate: p.start_date,
  endDate: p.end_date,
  annualPremium: p.annual_premium,
});

const quoteJson = (q: { id: string; input: object; premium: object }) => ({ quoteId: q.id, ...q.input, premium: q.premium });

const batchJson = (b: Row) => ({
  jobId: b.id,
  job: b.job,
  businessDate: b.business_date,
  status: b.status,
  startedAt: b.started_at,
  finishedAt: b.finished_at ?? null,
  fileName: b.file_name ?? null,
  recordCount: b.record_count ?? null,
  totalAmount: b.total_amount ?? null,
});

export function startApi(svc: Services, port: number, host: string): Server {
  const tokens = new Map<string, Token>();
  const spec = () => readFileSync(join(ROOT, 'app', 'openapi.yaml'), 'utf8');

  const auth = (req: IncomingMessage, scope: string): Token => {
    const m = /^Bearer\s+([\w-]+)$/i.exec(req.headers.authorization ?? '');
    const t = m ? tokens.get(m[1]) : undefined;
    if (!t || t.expires < Date.now()) throw new HttpError(401, 'a valid bearer token is required', 'unauthorized');
    if (!t.scopes.has(scope)) throw new HttpError(403, `the token lacks the "${scope}" scope`, 'insufficient_scope');
    return t;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/openapi.yaml') return send(res, 200, spec(), 'application/yaml; charset=utf-8');
    if (path === '/v1/health') {
      svc.db.prepare('SELECT 1').get();
      return json(res, 200, { status: 'UP', service: 'larkspur-api', time: svc.now() });
    }

    if (path === '/oauth/token' && method === 'POST') {
      const form = new URLSearchParams((await readBody(req)).toString('utf8'));
      let id = form.get('client_id') ?? '';
      let secret = form.get('client_secret') ?? '';
      const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '');
      if (basic) [id, secret] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      if (form.get('grant_type') !== 'client_credentials') return json(res, 400, { error: 'unsupported_grant_type' });
      const client = svc.db.prepare('SELECT * FROM api_clients WHERE id = ?').get(id) as Row | undefined;
      if (!client || client.secret_hash !== hashPassword(secret)) return json(res, 401, { error: 'invalid_client' }, { 'www-authenticate': 'Basic realm="larkspur"' });
      const allowed = new Set(String(client.scopes).split(' '));
      const asked = form.get('scope') ? form.get('scope')!.split(' ') : [...allowed];
      if (asked.some((s) => !allowed.has(s))) return json(res, 400, { error: 'invalid_scope' });
      const token = randomBytes(24).toString('base64url');
      tokens.set(token, { client: id, scopes: new Set(asked), expires: Date.now() + 900_000 });
      return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 900, scope: asked.join(' ') });
    }

    if (path === '/graphql' && method === 'POST') {
      const tok = auth(req, 'claims:read');
      const body = await readJson<{ query?: string; variables?: Record<string, unknown> }>(req);
      if (!body.query) throw new HttpError(400, 'query is required');
      const claimNode = (c: Row | undefined): Resolved | null =>
        c
          ? {
              __typename: 'Claim',
              ...claimJson(svc, c, false),
              id: c.id,
              policy: () => policyNode(svc.policy(String(c.policy_id))),
              documents: () => svc.claimDocuments(String(c.id)).map((d) => ({ __typename: 'Document', filename: d.filename, size: d.size, sha256: d.sha256 })),
            }
          : null;
      const policyNode = (p: Row | undefined): Resolved | null =>
        p
          ? {
              __typename: 'Policy',
              ...policyJson(p),
              id: p.id,
              holder: () => {
                const cu = svc.customer(String(p.customer_id))!;
                return { __typename: 'Customer', id: cu.id, fullName: cu.full_name, region: cu.region, segment: cu.segment };
              },
              claims: (a: { status?: string }) => svc.claimsOf(String(p.customer_id), a.status).filter((c) => c.policy_id === p.id).map((c) => claimNode(c)),
            }
          : null;
      const out = await executeGraphQL(
        {
          Query: {
            __typename: 'Query',
            claim: (a: { id?: string }) => claimNode(svc.claim(String(a.id))),
            policy: (a: { id?: string }) => policyNode(svc.policy(String(a.id))),
            claims: (a: { customerId?: string; status?: string; first?: number }) => svc.claimsOf(String(a.customerId), a.status).slice(0, Number(a.first ?? 50)).map((c) => claimNode(c)),
          },
          Mutation: {
            __typename: 'Mutation',
            createQuote: (a: { input?: Record<string, unknown> }) => {
              if (!tok.scopes.has('quotes:write')) throw new HttpError(403, 'createQuote needs the quotes:write scope');
              const q = svc.quote(a.input ?? {}, 'BROKER');
              return { __typename: 'Quote', ...quoteJson(q), premium: { __typename: 'Premium', ...q.premium } };
            },
          },
        },
        body.query,
        body.variables ?? {},
      );
      return json(res, 200, out);
    }

    // ---------------------------------------------------------------- REST v1
    let m: RegExpExecArray | null;
    if ((m = /^\/v1\/policies\/([\w-]+)$/.exec(path)) && method === 'GET') {
      auth(req, 'policies:read');
      const p = svc.policy(m[1]);
      if (!p) throw new HttpError(404, `policy ${m[1]} not found`, 'policy_not_found');
      return json(res, 200, policyJson(p));
    }
    if ((m = /^\/v1\/customers\/([\w-]+)\/policies$/.exec(path)) && method === 'GET') {
      auth(req, 'policies:read');
      if (!svc.customer(m[1])) throw new HttpError(404, `customer ${m[1]} not found`, 'customer_not_found');
      return json(res, 200, { items: svc.policies(m[1]).map(policyJson) });
    }
    if (path === '/v1/quotes' && method === 'POST') {
      auth(req, 'quotes:write');
      const q = svc.quote(await readJson(req), 'BROKER');
      return json(res, 201, quoteJson(q), { location: `/v1/quotes/${q.id}` });
    }
    if ((m = /^\/v1\/quotes\/([\w-]+)$/.exec(path)) && method === 'GET') {
      auth(req, 'quotes:write');
      const q = svc.quoteById(m[1]);
      if (!q) throw new HttpError(404, `quote ${m[1]} not found`, 'quote_not_found');
      return json(res, 200, {
        quoteId: q.id, product: q.product, sumInsured: q.sum_insured, region: q.region, riskAge: q.risk_age, noClaimsYears: q.no_claims_years,
        premium: { basePremium: q.base_premium, loadedPremium: q.loaded_premium, discount: q.discount, netPremium: q.net_premium, tax: q.tax, totalPremium: q.total_premium },
      });
    }
    if (path === '/v1/claims' && method === 'POST') {
      auth(req, 'claims:write');
      const b = await readJson(req);
      const c = svc.createClaim(
        { policyId: String(b.policyId ?? ''), type: String(b.type ?? ''), incidentDate: String(b.incidentDate ?? ''), amountClaimed: Number(b.amountClaimed), description: String(b.description ?? ''), externalRef: b.externalRef ? String(b.externalRef) : undefined },
        'BROKER',
      );
      return json(res, 201, claimJson(svc, c), { location: `/v1/claims/${c.id}` });
    }
    if (path === '/v1/claims' && method === 'GET') {
      auth(req, 'claims:read');
      const customerId = url.searchParams.get('customerId');
      if (!customerId) throw new HttpError(400, 'customerId is required', 'bad_request');
      const all = svc.claimsOf(customerId, url.searchParams.get('status') ?? undefined);
      const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50));
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return json(res, 200, { items: all.slice(offset, offset + limit).map((c) => claimJson(svc, c, false)), total: all.length, limit, offset });
    }
    if ((m = /^\/v1\/claims\/([\w-]+)$/.exec(path)) && method === 'GET') {
      auth(req, 'claims:read');
      const c = svc.claim(m[1]);
      if (!c) throw new HttpError(404, `claim ${m[1]} not found`, 'claim_not_found');
      return json(res, 200, claimJson(svc, c));
    }
    if (path === '/v1/batch/jobs' && method === 'POST') {
      auth(req, 'batch:run');
      const b = await readJson(req);
      if ((b.job ?? BATCH_JOB) !== BATCH_JOB) throw new HttpError(404, `unknown job ${String(b.job)}`, 'unknown_job');
      const run = startBatch(svc, String(b.businessDate ?? svc.now().slice(0, 10)));
      return json(res, 202, batchJson(run), { location: `/v1/batch/jobs/${run.id}` });
    }
    if ((m = /^\/v1\/batch\/jobs\/([\w-]+)$/.exec(path)) && method === 'GET') {
      auth(req, 'batch:run');
      const run = batchRun(svc, m[1]);
      if (!run) throw new HttpError(404, `job ${m[1]} not found`, 'job_not_found');
      return json(res, 200, batchJson(run));
    }
    throw new HttpError(404, `no route for ${method} ${path}`, 'not_found');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const err = e instanceof HttpError ? e : new HttpError(500, 'internal error', 'internal');
      if (!(e instanceof HttpError)) svc.log(`[api] ${(e as Error).stack}`);
      const headers: Record<string, string> = err.status === 401 ? { 'www-authenticate': 'Bearer realm="larkspur"' } : {};
      json(res, err.status, { error: err.code, message: err.message }, headers);
    });
  });
  server.listen(port, host);
  return server;
}
