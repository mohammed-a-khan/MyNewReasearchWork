/**
 * Configuration that EZTest no longer supports because it integrated with
 * another testing tool (see CHANGELOG "Removed: integrations with other
 * testing tools"). Such keys are taken out of the config before validation and
 * each one is reported as a warning with what to use instead, so an old
 * config still loads and says exactly what to change.
 */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

const CONTRACT_KEYS: Record<string, string> = {
  broker: 'Pact Broker support was removed; contracts are published to the EZTest results server: set `server:` and run `eztest contracts publish` (docs/api-contracts.md)',
  pacticipant: 'replace it with `contracts.app` (this application\'s name on the EZTest results server)',
  canIDeploy: 'replace it with `contracts.canRelease: { environment: ... }` and run `eztest contracts can-release`',
};

const REMOVED_PUBLISHERS: Record<string, string> = {
  xray: 'Xray', zephyr: 'Zephyr Scale', testrail: 'TestRail', qtest: 'qTest', octane: 'ALM Octane',
};

/** Remove unsupported keys from a raw (merged) config; returns the cleaned copy and one warning per removed key. */
export function stripRemovedKeys(raw: unknown): { raw: unknown; warnings: string[] } {
  if (!isObj(raw)) return { raw, warnings: [] };
  const out: Obj = { ...raw };
  const warnings: string[] = [];
  const warn = (key: string, hint: string) => warnings.push(`Configuration key "${key}" is no longer supported and was ignored: ${hint}`);

  if (isObj(out.contracts)) {
    const c: Obj = { ...out.contracts };
    for (const [k, hint] of Object.entries(CONTRACT_KEYS)) {
      if (k in c) {
        warn(`contracts.${k}`, hint);
        delete c[k];
      }
    }
    if (isObj(c.provider) && 'messages' in c.provider) {
      const p: Obj = { ...c.provider };
      warn('contracts.provider.messages', 'message contracts are now expectations of kind "message" in the contract file; map each one under `contracts.provider.messageProducers` (docs/api-contracts.md#message-contracts)');
      if (!('messageProducers' in p)) p.messageProducers = p.messages;
      delete p.messages;
      c.provider = p;
    }
    if (c.dir === 'pacts') warnings.push('contracts.dir is "pacts": EZTest contracts are `*.contract.json` files (format: eztest-contract); Pact files in that directory are not read (docs/api-contracts.md)');
    out.contracts = c;
  }

  if (isObj(out.trace) && 'playwright' in out.trace) {
    const t: Obj = { ...out.trace };
    warn('trace.playwright', 'renamed to `trace.browser` (the browser trace zip is EZTest\'s own format); the value was used for trace.browser');
    if (!('browser' in t)) t.browser = t.playwright;
    delete t.playwright;
    out.trace = t;
  }

  if (isObj(out.email) && (out.email.provider === 'mailpit' || out.email.provider === 'mailhog')) {
    warn(`email.provider: ${String(out.email.provider)}`, 'use EZTest\'s built-in SMTP sink: `email: { provider: sink, port: 2525 }` and point the application\'s SMTP settings at it');
    delete out.email;
  }

  if (Array.isArray(out.reporters) && out.reporters.some((r) => String(r).toLowerCase() === 'ctrf')) {
    warn('reporters: ctrf', 'the CTRF format was removed; use `junit` (JUnit XML, which Azure DevOps pipelines ingest), `json` or `html`');
    out.reporters = out.reporters.filter((r) => String(r).toLowerCase() !== 'ctrf');
  }

  if (Array.isArray(out.publishers)) {
    out.publishers = out.publishers.filter((p, i) => {
      const use = isObj(p) ? String(p.use ?? '').toLowerCase() : '';
      if (!(use in REMOVED_PUBLISHERS)) return true;
      warn(`publishers[${i}].use: ${use}`, `the ${REMOVED_PUBLISHERS[use]} publisher was removed; publish to Azure DevOps Test Plans (\`ado:\`), Jira, Slack or Teams instead, or write a plugin publisher (docs/plugins.md)`);
      return false;
    });
  }
  return { raw: out, warnings };
}
