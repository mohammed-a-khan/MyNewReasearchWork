/**
 * "ClaimDesk", the Larkspur back office: a classic server-rendered app for
 * claims adjusters. Adjusters approve up to their limit; larger claims are
 * referred to a senior adjuster. Rejections ask for confirmation.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hashPassword, type Row } from './db.ts';
import { cookie, esc, HttpError, money, readForm, redirect, send, setCookie } from './http.ts';
import type { Services } from './services.ts';

const REASONS = [
  ['COVERED', 'Covered in full'],
  ['PARTIAL_COVER', 'Partially covered'],
  ['NOT_COVERED', 'Not covered'],
  ['POLICY_EXCLUSION', 'Policy exclusion'],
  ['INSUFFICIENT_EVIDENCE', 'Insufficient evidence'],
  ['OVER_AUTHORITY', 'Over my authority'],
];
const STATUS = { SUBMITTED: 'New', IN_REVIEW: 'In review', REFERRED: 'Referred', APPROVED: 'Approved', REJECTED: 'Rejected', SETTLEMENT_ACCEPTED: 'Settlement accepted', SETTLED: 'Settled' } as Record<string, string>;

const page = (title: string, staff: Row | undefined, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)} | ClaimDesk</title>
<style>
body{font:14px/1.4 Verdana,Geneva,sans-serif;margin:0;color:#222;background:#fafafa}
.top{background:#263238;color:#eceff1;padding:8px 16px;display:flex;gap:16px;align-items:center}
.top a{color:#b2dfdb}.top .who{margin-left:auto}
.wrap{padding:12px 16px;max-width:72rem}
table{border-collapse:collapse;width:100%;background:#fff}th,td{border:1px solid #cfd8dc;padding:4px 8px;text-align:left}
th{background:#eceff1}.msg{padding:8px;margin:8px 0;border:1px solid}.ok{background:#e8f5e9;border-color:#2e7d32}.err{background:#ffebee;border-color:#c62828}
fieldset{background:#fff;border:1px solid #b0bec5;margin:12px 0}label{display:inline-block;min-width:11rem}
.facts td:first-child{width:14rem;font-weight:bold}
</style></head><body>
<div class="top"><strong>ClaimDesk</strong>${staff ? `<a href="/queue">Queue</a><span class="who">${esc(staff.full_name)} (${esc(String(staff.role).toLowerCase())})</span><a href="/signout">Sign out</a>` : ''}</div>
<div class="wrap">${body}</div></body></html>`;

export function startBackoffice(svc: Services, port: number, host: string): Server {
  const sessions = new Map<string, { staff: string; expires: number }>();
  const staffOf = (req: IncomingMessage): Row | undefined => {
    const id = cookie(req, 'cd_sess');
    const s = id ? sessions.get(id) : undefined;
    if (!s || s.expires < Date.now()) return undefined;
    s.expires = Date.now() + 20 * 60_000;
    return svc.db.prepare('SELECT * FROM staff WHERE username = ?').get(s.staff) as Row | undefined;
  };

  const signin = (error?: string) =>
    page(
      'Sign in',
      undefined,
      `<h1>Staff sign-in</h1>${error ? `<p class="msg err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/signin"><p><label for="staffId">Staff ID</label><input id="staffId" name="staffId"></p>
<p><label for="passphrase">Passphrase</label><input id="passphrase" name="passphrase" type="password"></p>
<p><button type="submit">Sign in</button></p></form>`,
    );

  const queue = (staff: Row, url: URL) => {
    const q = (url.searchParams.get('q') ?? '').trim();
    const show = url.searchParams.get('show') ?? 'open';
    const statuses = show === 'referred' ? ['REFERRED'] : show === 'all' ? Object.keys(STATUS) : ['SUBMITTED', 'IN_REVIEW', 'REFERRED'];
    const rows = svc.db
      .prepare(
        `SELECT c.*, cu.full_name FROM claims c JOIN customers cu ON cu.id = c.customer_id
          WHERE c.status IN (${statuses.map(() => '?').join(',')}) AND (? = '' OR c.id = ? OR cu.full_name LIKE ? OR c.policy_id = ?)
          ORDER BY c.reported_at DESC, c.id DESC LIMIT 50`,
      )
      .all(...statuses, q, q, `%${q}%`, q) as Row[];
    return page(
      'Claims queue',
      staff,
      `<h1>Claims queue</h1>
<form method="get" action="/queue" role="search"><label for="q">Find claim</label><input id="q" name="q" value="${esc(q)}">
<label for="show" style="min-width:auto">Show</label><select id="show" name="show">
${[['open', 'Open claims'], ['referred', 'Referred'], ['all', 'All claims']].map(([v, t]) => `<option value="${v}"${v === show ? ' selected' : ''}>${t}</option>`).join('')}</select>
<button type="submit">Search</button></form>
<p>${rows.length} claim(s)</p>
<table aria-label="Claims queue"><thead><tr><th>Claim</th><th>Customer</th><th>Policy</th><th>Type</th><th>Amount</th><th>Priority</th><th>Status</th><th>Received</th><th>Action</th></tr></thead><tbody>
${rows
  .map(
    (r) =>
      `<tr><td>${esc(r.id)}</td><td>${esc(r.full_name)}</td><td>${esc(r.policy_id)}</td><td>${esc(r.type)}</td><td>${money(Number(r.amount_claimed))}</td><td>${esc(r.priority)}</td><td>${esc(STATUS[String(r.status)])}</td><td>${esc(String(r.reported_at).slice(0, 16).replace('T', ' '))}</td><td><a href="/claims/${esc(r.id)}">Review</a></td></tr>`,
  )
  .join('')}
</tbody></table>`,
    );
  };

  const review = (staff: Row, id: string, flash?: { ok?: string; err?: string }) => {
    const c = svc.claim(id);
    if (!c) throw new HttpError(404, `claim ${id} not found`);
    const cust = svc.customer(String(c.customer_id))!;
    const policy = svc.policy(String(c.policy_id))!;
    const docs = svc.claimDocuments(id);
    const history = svc.db.prepare("SELECT COUNT(*) AS n, SUM(status = 'REJECTED') AS rejected FROM claims WHERE customer_id = ? AND id <> ?").get(String(c.customer_id), id) as Row;
    const open = ['SUBMITTED', 'IN_REVIEW', 'REFERRED'].includes(String(c.status));
    const mayDecide = open && !(c.status === 'REFERRED' && staff.role !== 'SENIOR');
    return page(
      `Review ${id}`,
      staff,
      `<h1>Review claim ${esc(id)}</h1>
${flash?.ok ? `<p class="msg ok" role="status">${esc(flash.ok)}</p>` : ''}${flash?.err ? `<p class="msg err" role="alert">${esc(flash.err)}</p>` : ''}
<table class="facts" aria-label="Claim facts"><tbody>
<tr><td>Status</td><td id="status">${esc(STATUS[String(c.status)])}</td></tr>
<tr><td>Customer</td><td>${esc(cust.full_name)} (${esc(cust.id)})</td></tr>
<tr><td>Policy</td><td>${esc(policy.id)} ${esc(policy.product)}, sum insured ${money(Number(policy.sum_insured))}, excess ${money(Number(policy.deductible))}</td></tr>
<tr><td>Type</td><td>${esc(c.type)}</td></tr><tr><td>Incident date</td><td>${esc(c.incident_date)}</td></tr>
<tr><td>Amount claimed</td><td id="amount-claimed">${money(Number(c.amount_claimed))}</td></tr>
<tr><td>Priority</td><td>${esc(c.priority)}</td></tr>
<tr><td>Late notification</td><td>${c.late_notification ? 'Yes' : 'No'}</td></tr>
<tr><td>Description</td><td>${esc(c.description)}</td></tr>
<tr><td>Documents</td><td>${docs.map((d) => esc(d.filename)).join(', ') || 'none'}</td></tr>
<tr><td>Previous claims</td><td id="history">${Number(history.n)} (${Number(history.rejected ?? 0)} rejected)</td></tr>
${c.approved_amount !== null ? `<tr><td>Approved amount</td><td id="approved-amount">${money(Number(c.approved_amount))}</td></tr><tr><td>Payout</td><td id="payout">${money(Number(c.payout_amount))}</td></tr>` : ''}
<tr><td>Your approval limit</td><td>${money(Number(staff.approval_limit))}</td></tr>
</tbody></table>
${
  mayDecide
    ? `<form method="post" action="/claims/${esc(id)}/decision"><fieldset><legend>Decision</legend>
<p><label for="approvedAmount">Approved amount</label><input id="approvedAmount" name="approvedAmount" inputmode="decimal" value="${money(Number(c.amount_claimed))}"></p>
<p><label for="reason">Decision reason</label><select id="reason" name="reason"><option value="">Choose a reason</option>${REASONS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></p>
<p><button type="submit" name="action" value="approve">Approve</button>
<button type="submit" name="action" value="reject" onclick="return confirm('Reject claim ${esc(id)}? The customer will be notified.')">Reject</button>
${staff.role === 'SENIOR' ? '' : '<button type="submit" name="action" value="refer">Refer to senior</button>'}</p></fieldset></form>`
    : `<p>No decision needed${c.decision_by ? `: decided by ${esc(c.decision_by)}` : ''}.</p>`
}`,
    );
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    if (path === '/health') return send(res, 200, '{"status":"UP","app":"backoffice"}', 'application/json');
    if (path === '/signin' && req.method === 'GET') return send(res, 200, signin());
    if (path === '/signin' && req.method === 'POST') {
      const f = await readForm(req);
      const s = svc.db.prepare('SELECT * FROM staff WHERE username = ?').get(String(f.get('staffId') ?? '').trim()) as Row | undefined;
      if (!s || s.password_hash !== hashPassword(String(f.get('passphrase') ?? ''))) return send(res, 401, signin('Unknown staff ID or wrong passphrase.'));
      const id = randomBytes(18).toString('hex');
      sessions.set(id, { staff: String(s.username), expires: Date.now() + 20 * 60_000 });
      return redirect(res, '/queue', { 'set-cookie': setCookie('cd_sess', id) });
    }
    if (path === '/signout') return redirect(res, '/signin', { 'set-cookie': setCookie('cd_sess', '', { maxAge: 0 }) });
    const staff = staffOf(req);
    if (!staff) return redirect(res, '/signin');
    if (path === '/' || path === '/queue') return send(res, 200, queue(staff, url));
    let m: RegExpExecArray | null;
    if ((m = /^\/claims\/(CLM-\d+)$/.exec(path))) {
      svc.assign(m[1], String(staff.username));
      const done = url.searchParams.get('done');
      const c = svc.claim(m[1]);
      const ok =
        done === 'approve'
          ? `Claim ${m[1]} approved. Settlement of ${money(Number(c?.payout_amount))} GBP offered to the customer.`
          : done === 'reject'
            ? `Claim ${m[1]} rejected. The customer has been notified.`
            : done === 'refer'
              ? `Claim ${m[1]} referred to a senior adjuster.`
              : undefined;
      return send(res, 200, review(staff, m[1], { ok }));
    }
    if ((m = /^\/claims\/(CLM-\d+)\/decision$/.exec(path)) && req.method === 'POST') {
      const f = await readForm(req);
      const action = String(f.get('action') ?? '');
      const decision = action === 'approve' ? 'APPROVE' : action === 'reject' ? 'REJECT' : action === 'refer' ? 'REFER' : undefined;
      try {
        if (!decision) throw new HttpError(400, 'choose approve, reject or refer');
        svc.decide(m[1], staff, decision, { approvedAmount: Number(String(f.get('approvedAmount') ?? '').replace(/,/g, '')), reason: String(f.get('reason') ?? '') });
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        return send(res, e.status, review(staff, m[1], { err: e.message }));
      }
      return redirect(res, `/claims/${m[1]}?done=${action}`);
    }
    throw new HttpError(404, 'not found');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const err = e instanceof HttpError ? e : new HttpError(500, 'internal error');
      if (!(e instanceof HttpError)) svc.log(`[backoffice] ${(e as Error).stack}`);
      send(res, err.status, page('Error', undefined, `<h1>Error ${err.status}</h1><p>${esc(err.message)}</p>`));
    });
  });
  server.listen(port, host);
  return server;
}
