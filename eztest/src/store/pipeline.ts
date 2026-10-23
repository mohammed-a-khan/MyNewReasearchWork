/**
 * Handing shared-store values to the CI system, so a later stage or job can
 * use them:
 *
 * - Azure Pipelines: `##vso[task.setvariable variable=<name>;isOutput=true]<value>`
 *   (with `issecret=true` for secrets). Name the step that runs EZTest
 *   (`name: eztest`) and map the value in a later stage with
 *   `$[ stageDependencies.<stage>.<job>.outputs['eztest.<name>'] ]` (a runOnce
 *   deployment job: `outputs['<job>.eztest.<name>']`), for example into EZTEST_STORE_<NAME>.
 * - GitHub Actions: `<name>=<value>` lines appended to $GITHUB_OUTPUT (job
 *   outputs: `needs.<job>.outputs.<name>`). GitHub drops outputs that contain
 *   a masked secret, so a secret is passed sealed (decrypted again by the next
 *   job's EZTest with the same store key) and its plain value is masked.
 *
 * Values that are not text are passed as JSON.
 */
import { randomBytes } from 'node:crypto';

export interface OutputEntry {
  variable: string;
  key: string;
  plain: string;
  secret?: boolean;
  sealed?: string;
}

/** Escaping of Azure Pipelines logging commands (data part). */
export function vsoEscapeData(s: string): string {
  return s.replace(/%/g, '%AZP25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escaping of Azure Pipelines logging command properties. */
export function vsoEscapeProperty(s: string): string {
  return vsoEscapeData(s).replace(/;/g, '%3B').replace(/]/g, '%5D');
}

export function vsoSetVariable(name: string, value: string, o: { output?: boolean; secret?: boolean } = {}): string {
  const props = [`variable=${vsoEscapeProperty(name)}`, ...(o.output !== false ? ['isOutput=true'] : []), ...(o.secret ? ['issecret=true'] : [])];
  return `##vso[task.setvariable ${props.join(';')}]${vsoEscapeData(value)}`;
}

/** One $GITHUB_OUTPUT entry (heredoc form for values with line breaks). */
export function githubOutputLine(name: string, value: string): string {
  if (!/[\r\n]/.test(value)) return `${name}=${value}\n`;
  let delim = `EZTEST_${randomBytes(6).toString('hex')}`;
  while (value.includes(delim)) delim = `EZTEST_${randomBytes(6).toString('hex')}`;
  return `${name}<<${delim}\n${value}\n${delim}\n`;
}

export type CiOutputSystem = 'azure' | 'github';

/** Which CI systems receive output variables: EZTEST_PIPELINE_OUTPUTS (azure,github,none), else detected. */
export function outputSystems(env: Record<string, string | undefined>): CiOutputSystem[] {
  const forced = env.EZTEST_PIPELINE_OUTPUTS;
  if (forced) return forced.split(',').map((s) => s.trim().toLowerCase()).filter((s): s is CiOutputSystem => s === 'azure' || s === 'github');
  const out: CiOutputSystem[] = [];
  if (/^true$/i.test(env.TF_BUILD ?? '')) out.push('azure');
  if (env.GITHUB_OUTPUT) out.push('github');
  return out;
}

export function formatOutputs(entries: OutputEntry[], env: Record<string, string | undefined>): { lines: string[]; githubOutput?: string } {
  const systems = outputSystems(env);
  const lines: string[] = [];
  let gh = '';
  for (const e of entries) {
    if (systems.includes('azure')) lines.push(vsoSetVariable(e.variable, e.plain, { secret: e.secret }));
    if (systems.includes('github')) {
      if (e.secret) lines.push(`::add-mask::${e.plain}`);
      gh += githubOutputLine(e.variable, e.secret && e.sealed ? e.sealed : e.plain);
    }
  }
  return { lines, ...(gh ? { githubOutput: gh } : {}) };
}
