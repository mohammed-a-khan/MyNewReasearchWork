/** A short, masked view of the effective configuration (for `eztest doctor`). */
import type { LoadedConfig } from '../config/index.js';

export function effectiveSummary(l: LoadedConfig): string[] {
  const c = l.config;
  const m = (s: string) => l.masker.mask(s);
  const out: string[] = [];
  out.push(`environment ${c.environment}${c.project ? `, project ${c.project}` : ''}`);
  out.push(`baseUrl     ${c.baseUrl ? m(c.baseUrl) : '(none)'}`);
  out.push(`browser     ${c.browser}${c.channel ? ` (channel ${c.channel})` : ''}, ${c.headless ? 'headless' : 'headed'}, concurrency ${c.concurrency}, retries ${c.retries}`);
  out.push(`timeouts    step ${c.timeouts.step} ms, navigation ${c.timeouts.navigation} ms, api ${c.timeouts.api} ms, db ${c.timeouts.db} ms`);
  out.push(`evidence    screenshots ${c.screenshots ?? 'every-step (CLI default)'}, video ${c.video}, trace ${c.trace.browser}`);
  if (c.waits.loaders.length) out.push(`loaders     ${c.waits.loaders.join(', ')} (cap ${c.waits.loaderTimeoutMs} ms)`);
  const dbs = Object.entries(c.db.connections);
  if (dbs.length) out.push(`databases   ${dbs.map(([n, d]) => `${n} (${(d as { driver: string }).driver})`).join(', ')}${c.db.queries ? `; queries ${c.db.queries.dir}` : ''}`);
  const roles = Object.entries(c.identity.roles);
  if (roles.length) out.push(`roles       ${roles.map(([n, r]) => `${n} (${r.login?.type ?? 'form'}${r.passwordRotation ? `, rotation ${r.passwordRotation.type}` : ''})`).join(', ')}`);
  if (c.api.clientCertificates.length) out.push(`mTLS        ${c.api.clientCertificates.map((x) => `${x.name ?? '(unnamed)'} -> ${x.origin}`).join(', ')}`);
  if (c.ado.enabled) out.push(`ado         ${c.ado.organizationUrl ?? '?'} / ${c.ado.project ?? '?'}${c.ado.testPlanId ? ` plan ${c.ado.testPlanId}` : ''}`);
  const vars = Object.keys(c.vars);
  if (vars.length) out.push(`vars        ${vars.length} (${vars.slice(0, 6).join(', ')}${vars.length > 6 ? ', ...' : ''})`);
  if (c.templates.syntax !== 'dollar') out.push(`templates   ${c.templates.syntax}`);
  return out;
}
