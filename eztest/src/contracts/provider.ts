/**
 * Provider verification from configuration: provider states become data
 * hooks (catalogue queries, SQL with bound ${params}, HTTP setup calls on the
 * provider, or journeys run with the state's params as variables), and
 * message expectations are produced by triggering the provider and reading
 * what it publishes on its broker.
 */
import { EzTestError, interpolate, renderTemplate, type Journey } from '../core/index.js';
import type { Engine } from '../engine/index.js';
import { bindSql } from '../runner/data-steps.js';
import { resolveUrl } from '../runner/api.js';
import type { Integration } from '../integration/runtime.js';
import type { ContractsConfig, ProviderStateConfig } from './config.js';
import type { MessageExpectation, ProviderState } from './model.js';
import type { MessageProducer, StateAction, StateHandler } from './verify.js';

type Step = Omit<ProviderStateConfig, 'teardown'>;

export interface ProviderHookContext {
  engine?: Engine;
  baseUrl?: string;
  /** Journeys by id/name/file (for `journey:` states). */
  resolveJourney?: (ref: string) => Promise<Journey | undefined>;
  headers?: () => Promise<Record<string, string>>;
}

async function runStep(s: Step, state: ProviderState, ctx: ProviderHookContext): Promise<void> {
  const params = (state.params ?? {}) as Record<string, unknown>;
  const vars = { ...params, state: state.name };
  if (s.query || s.sql) {
    if (!ctx.engine) throw new EzTestError('provider state with a query needs the EZTest engine (db config)', 'CONTRACT_STATE');
    if (s.query) {
      const cat = await ctx.engine.queries();
      const conn = s.on || cat.get(s.query).connection;
      if (!conn) throw new EzTestError(`provider state "${state.name}": query ${s.query} has no connection (add "on:")`, 'CONTRACT_STATE');
      const client = await ctx.engine.dbs.get(conn);
      const binds = Object.fromEntries(Object.entries(s.with ?? {}).map(([k, v]) => [k, typeof v === 'string' ? (/^\$\{(\w+)\}$/.test(v) ? (params[/^\$\{(\w+)\}$/.exec(v)![1]] as string) : interpolate(v, vars)) : v]));
      const c = cat.compile(s.query, { binds: binds as Record<string, string | number | boolean | null> }, client.dialect);
      await client.query(c.sql, c.params as never);
    } else {
      if (!s.on) throw new EzTestError(`provider state "${state.name}": sql needs "on: <connection>"`, 'CONTRACT_STATE');
      const client = await ctx.engine.dbs.get(s.on);
      const bound = bindSql(s.sql!, [], vars, client.dialect);
      await client.query(bound.sql, bound.params as never);
    }
  }
  if (s.request) {
    const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i.exec(s.request.trim());
    if (!m) throw new EzTestError(`provider state "${state.name}": request must look like "POST /path"`, 'CONTRACT_STATE');
    const res = await fetch(resolveUrl(interpolate(m[2], vars), ctx.baseUrl), {
      method: m[1].toUpperCase(),
      headers: { 'content-type': 'application/json', ...((await ctx.headers?.()) ?? {}) },
      ...(s.body !== undefined ? { body: renderTemplate(JSON.stringify(s.body), vars) } : {}),
    });
    if (!res.ok) throw new EzTestError(`provider state "${state.name}": ${s.request} returned HTTP ${res.status}`, 'CONTRACT_STATE');
  }
  if (s.journey) {
    if (!ctx.engine || !ctx.resolveJourney) throw new EzTestError('provider state with a journey needs the EZTest engine', 'CONTRACT_STATE');
    const j = await ctx.resolveJourney(s.journey);
    if (!j) throw new EzTestError(`provider state "${state.name}": journey ${s.journey} not found`, 'CONTRACT_STATE');
    const vstr = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const run = await ctx.engine.run([{ ...j, variables: { ...(j.variables ?? {}), ...vstr } }]);
    const r = run.journeys[0];
    if (!r || !/^passed/.test(r.status)) throw new EzTestError(`provider state "${state.name}": journey ${s.journey} ${r?.status ?? 'did not run'}${r?.error ? `: ${r.error.message}` : ''}`, 'CONTRACT_STATE');
  }
}

/** State handlers from contracts.provider.states. */
export function stateHandlersFromConfig(states: Record<string, ProviderStateConfig>, ctx: ProviderHookContext): Record<string, StateHandler> {
  const out: Record<string, StateHandler> = {};
  for (const [name, cfg] of Object.entries(states)) {
    out[name] = async (state: ProviderState, action: StateAction) => {
      if (action === 'setup') {
        const { teardown: _t, ...setup } = cfg;
        await runStep(setup, state, ctx);
      } else if (cfg.teardown) await runStep(cfg.teardown, state, ctx);
    };
  }
  return out;
}

/** Message producers from contracts.provider.messageProducers: trigger the provider, then read what it publishes on the expectation's channel. */
export function messageProducersFromConfig(producers: NonNullable<ContractsConfig['provider']>['messageProducers'], integration: Integration, ctx: ProviderHookContext): Record<string, MessageProducer> {
  const out: Record<string, MessageProducer> = {};
  for (const [description, m] of Object.entries(producers)) {
    out[description] = async (e: MessageExpectation) => {
      const driver = integration.driverFor(m.broker, m.broker ? undefined : e.channel.transport);
      const dest = { type: m.destType ?? e.channel.destType, name: m.dest ?? e.channel.dest };
      const sub = await driver.subscribe(dest, { fromTimestamp: Date.now() });
      try {
        if (m.trigger) {
          const t = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i.exec(m.trigger.trim());
          if (!t) throw new EzTestError(`message "${e.description}": trigger must look like "POST /path"`, 'CONTRACT_MESSAGE');
          const res = await fetch(resolveUrl(t[2], ctx.baseUrl), { method: t[1].toUpperCase(), headers: { 'content-type': 'application/json', ...((await ctx.headers?.()) ?? {}) }, ...(m.body !== undefined ? { body: JSON.stringify(m.body) } : {}) });
          if (!res.ok) throw new EzTestError(`message "${e.description}": trigger ${m.trigger} returned HTTP ${res.status}`, 'CONTRACT_MESSAGE');
        }
        const msg = await sub.next(() => true, m.timeoutMs);
        if (!msg) throw new EzTestError(`message "${e.description}": nothing was published on ${dest.type} "${dest.name}" within ${m.timeoutMs} ms`, 'CONTRACT_MESSAGE');
        let contents: unknown = msg.payload;
        try {
          contents = JSON.parse(msg.payload);
        } catch {
          // text message
        }
        const key = msg.key ?? (e.channel.transport === 'amqp' ? msg.routingKey : undefined);
        return { contents, ...(key !== undefined ? { key } : {}), headers: msg.headers };
      } finally {
        await sub.close();
      }
    };
  }
  return out;
}
