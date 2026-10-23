/** SAP GUI steps: connect, log on (secret:// password), transactions, fields, buttons, tables and the status bar. */
import { EzTestError } from '../core/index.js';
import { AgentClient, AgentError } from './agent.js';
import { failedStep, onSurface, type DesktopHandler, type HandlerEnv } from './interceptor.js';
import { SapSurface } from './sap.js';

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new EzTestError(`missing ${what}`, 'MISSING_VALUE');
  return v;
};

function sap(h: HandlerEnv): SapSurface {
  return h.need(['sap'], 'This SAP step') as unknown as SapSurface;
}

async function bridge(h: HandlerEnv): Promise<AgentClient> {
  const cfg = h.config.desktop.sap;
  if (!cfg) throw new EzTestError('SAP GUI needs a desktop.sap block (the URL of agents/sap/ez-sap-bridge.ps1 and the systems)', 'NO_CONFIG');
  const client = new AgentClient({ url: cfg.bridge, ...(cfg.token ? { token: await h.secret(cfg.token) } : {}), timeoutMs: cfg.timeoutMs });
  const hello = await client.hello();
  if (hello.agent !== 'sap') throw new AgentError(`${cfg.bridge} is the ${hello.agent} agent, not the SAP GUI bridge`, 'protocol');
  return client;
}

export const SAP_HANDLERS: Record<string, DesktopHandler> = {
  'sap.connect': async (step, ctx, rt, h) => {
    const system = str(h.args.system, 'SAP system');
    const def = h.config.desktop.sap?.systems[system];
    let s: SapSurface;
    try {
      const client = await bridge(h);
      await client.call('open', { connection: def?.connection ?? system });
      s = new SapSurface(system, client);
    } catch (e) {
      return failedStep(`could not connect to SAP "${system}": ${(e as Error).message}`);
    }
    h.open(`sap:${system}`, s);
    return onSurface(s, step, ctx, rt, async () => ({ surface: { driver: 'sap', rung: 'object', via: `connection "${def?.connection ?? system}"` }, newScreen: true }));
  },
  'sap.logon': async (step, ctx, rt, h) => {
    const s = sap(h);
    const name = typeof h.args.system === 'string' ? h.args.system : s.system;
    const def = h.config.desktop.sap?.systems[name];
    if (!def?.user || !def.password) return failedStep(`SAP system "${name}" has no user/password under desktop.sap.systems.${name}`);
    const password = (await h.secret(def.password)) ?? '';
    return onSurface(s, step, ctx, rt, async () => {
      const st = await s.client.call<{ type: string; text: string }>('login', { client: def.client, user: def.user, password, language: def.language });
      if (st.type === 'E' || st.type === 'A') throw new AgentError(`SAP logon failed: ${st.text}`, 'logon');
      return { surface: { driver: 'sap', rung: 'object', via: `logon ${def.user}${def.client ? ` client ${def.client}` : ''}` }, newScreen: true };
    });
  },
  'sap.transaction': async (step, ctx, rt, h) => {
    const s = sap(h);
    const code = str(h.args.code, 'transaction code').trim();
    return onSurface(s, step, ctx, rt, async () => {
      await s.client.call('transaction', { code });
      const scr = await s.screen();
      if (scr.window.transaction && scr.window.transaction.toUpperCase() !== code.replace(/^\/n/i, '').toUpperCase()) {
        const st = await s.status();
        throw new AgentError(`transaction ${code} did not start (now in ${scr.window.transaction}${st.text ? `: ${st.text}` : ''})`, 'transaction');
      }
      return { surface: { driver: 'sap', rung: 'object', via: `transaction ${code}: ${scr.window.title}` }, newScreen: true };
    });
  },
  'sap.set': async (step, ctx, rt, h) => {
    const s = sap(h);
    const field = str(h.args.field, 'field');
    const value = String(h.args.value ?? '');
    return onSurface(s, step, ctx, rt, async () => {
      const l = await s.locate({ description: `the "${field}" field`, locators: [] }, ctx, rt, step).catch(() => s.locate({ description: `"${field}"`, locators: [] }, ctx, rt, step));
      const now = await s.set(l, value);
      return { surface: { driver: 'sap', rung: 'object', via: `${l.el.type} ${l.el.id}` }, usedLocator: l.used, fingerprint: s.fingerprint(l.el), ...(l.heal ? { heal: l.heal } : {}), implied: { ok: now.trim() === value.trim(), message: `the field holds "${now}"` } };
    });
  },
  'sap.press': async (step, ctx, rt, h) => {
    const s = sap(h);
    const button = str(h.args.button, 'button');
    return onSurface(s, step, ctx, rt, async () => {
      const l = await s.locate({ description: `the "${button}" button`, locators: [] }, ctx, rt, step);
      await s.client.call('press', { id: l.el.id });
      return { surface: { driver: 'sap', rung: 'object', via: `${l.el.type} ${l.el.id}` }, usedLocator: l.used, fingerprint: s.fingerprint(l.el), ...(l.heal ? { heal: l.heal } : {}), newScreen: true };
    });
  },
  /** Status bar: expect text (`contains`), a message type (S/E/W/I/A), or capture it (`as`, optional `pattern`). */
  'sap.status': async (step, ctx, rt, h) => {
    const s = sap(h);
    return onSurface(s, step, ctx, rt, async () => {
      const deadline = Date.now() + rt.conditionTimeoutMs;
      for (;;) {
        const st = await s.status();
        let problem: string | undefined;
        if (typeof h.args.contains === 'string' && !st.text.toLowerCase().includes(h.args.contains.toLowerCase())) problem = `the SAP status bar says "${st.text}", expected it to contain "${h.args.contains}"`;
        if (typeof h.args.type === 'string' && st.type !== h.args.type) problem = `the SAP status bar message is type "${st.type || 'none'}" ("${st.text}"), expected "${h.args.type}"`;
        let captured: Record<string, unknown> | undefined;
        if (!problem && typeof h.args.as === 'string') {
          const m = typeof h.args.pattern === 'string' ? new RegExp(h.args.pattern).exec(st.text) : undefined;
          if (typeof h.args.pattern === 'string' && !m) problem = `the SAP status bar "${st.text}" has no ${h.args.pattern === '\\d+' ? 'number' : `match for /${h.args.pattern}/`}`;
          else captured = { [h.args.as]: m ? m[0] : st.text };
        }
        if (!problem) return { surface: { driver: 'sap', rung: 'object', via: `status bar ${st.type}: ${st.text}` }, ...(captured ? { captured } : {}) };
        if (Date.now() >= deadline) throw new AgentError(problem, 'assertion');
        await new Promise((r) => setTimeout(r, 200));
      }
    });
  },
  'sap.cell': async (step, ctx, rt, h) => {
    const s = sap(h);
    const table = str(h.args.table, 'table');
    return onSurface(s, step, ctx, rt, async () => {
      const l = await s.locate({ description: `the "${table}" table`, locators: [] }, ctx, rt, step);
      const r = await s.client.call<{ value?: string }>('cell', { id: l.el.id, row: Number(h.args.row), column: String(h.args.column), ...(h.args.value !== undefined ? { value: String(h.args.value) } : {}) });
      const value = String(r.value ?? '');
      return {
        surface: { driver: 'sap', rung: 'object', via: `${l.el.type} ${l.el.id} row ${String(h.args.row)} column "${String(h.args.column)}"` }, usedLocator: l.used,
        ...(h.args.value !== undefined ? { implied: { ok: value.trim() === String(h.args.value).trim(), message: `the cell holds "${value}"` } } : {}),
        ...(typeof h.args.as === 'string' ? { captured: { [h.args.as]: value } } : {}),
      };
    });
  },
};
