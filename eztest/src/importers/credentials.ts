/**
 * Imported tests often carry credentials as plain literals: a password typed
 * into a field, an `Authorization: Bearer ...` header, an API key, a token in
 * a request body or a Variables entry. Written journeys never keep them: each
 * credential-like literal becomes a `${NAME}` variable, and the import report
 * lists every one with the variable to provide and a `secret://` hint.
 *
 * Detection reads the parsed journey (step targets, API headers, bodies, form
 * and query fields, the Variables header) and, for lines that were not
 * converted (TODO lines), the source text (`password = "..."`, `Bearer ...`).
 * Replacement is textual, on the `.ez` that is written and on the TODO
 * originals in the report, so the literal is gone from every written file.
 */
import { flattenSteps, type Journey } from '../core/index.js';
import type { ConvertedJourney, TodoItem } from './types.js';

/** Words in a target description, header or field name that mark a credential. */
export const CREDENTIAL_NAME = /pass(?:word|wd|phrase|code)?|secret|token|api[-_ ]?key|\bpin\b|\botp\b|one[- ]time|credential|private[-_ ]?key|cvv|cvc/i;
const CREDENTIAL_HEADER = /^(?:authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|cookie)$/i;

export interface CredentialFinding {
  journeyId: string;
  /** Source file of the imported test. */
  file: string;
  /** The variable the literal was replaced with. */
  variable: string;
  /** What held it. */
  kind: 'field' | 'header' | 'body' | 'variable' | 'source-text';
  /** Field description, header name or key. */
  where: string;
  /** How to provide the value. */
  hint: string;
}

const hintFor = (v: string) => `provide ${v} as a secret: vars: { ${v}: secret://env/${v} } in eztest.config.yaml (a secret store reference, resolved and masked at run time), or a role's password: secret://env/${v} for logins`;

function varName(raw: string): string {
  const words = raw
    .replace(/\[[^\]]*\]|[#.][\w-]+/g, (m) => m.replace(/[^\w]+/g, ' '))
    .replace(/["'`]/g, ' ')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w && !/^(?:the|a|an|with|field|input|box|textbox|text|name|id|into|in|of|value|header|type|data|testid)$/i.test(w));
  const name = words.join('_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase().replace(/^(\d)/, '_$1');
  return name || 'SECRET';
}

const isLiteral = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && !v.includes('${') && !v.startsWith('secret://') && !/^ENC\(/.test(v) && !/^\{\{.*\}\}$/.test(v);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace a literal where it stands as a whole value (quoted, after Bearer/Basic, or alone), keeping `${...}` text intact. */
function replaceLiteral(text: string, literal: string, variable: string): string {
  const ref = `\${${variable}}`;
  const lit = escapeRe(literal);
  let out = text
    .replace(new RegExp(`(\\\\?["'\`])${lit}(\\\\?["'\`])`, 'g'), (_m, a: string, b: string) => `${a}${ref}${b}`)
    .replace(new RegExp(`\\b(Bearer|Basic|Token)\\s+${lit}(?![\\w-])`, 'g'), (_m, w: string) => `${w} ${ref}`);
  // Long enough to be unambiguous: every remaining occurrence goes too.
  if (literal.length >= 6) out = out.split(literal).join(ref);
  return out;
}

interface Hit {
  literal: string;
  name: string;
  kind: CredentialFinding['kind'];
  where: string;
}

function hitsOf(journey: Journey | undefined): Hit[] {
  const out: Hit[] = [];
  if (!journey) return out;
  for (const [k, v] of Object.entries(journey.variables ?? {})) if (CREDENTIAL_NAME.test(k) && isLiteral(v)) out.push({ literal: v, name: varName(k), kind: 'variable', where: k });
  for (const s of flattenSteps(journey.steps)) {
    const desc = [s.target?.description, ...(s.target?.locators ?? []).map((l) => `${l.value} ${l.name ?? ''}`)].filter(Boolean).join(' ');
    if (s.value !== undefined && isLiteral(s.value) && CREDENTIAL_NAME.test(desc)) out.push({ literal: s.value, name: varName(s.target?.description ?? desc), kind: 'field', where: s.target?.description ?? desc });
    const api = s.api;
    if (!api) continue;
    for (const [h, v] of Object.entries(api.headers ?? {})) {
      if (!(CREDENTIAL_HEADER.test(h) || CREDENTIAL_NAME.test(h)) || typeof v !== 'string') continue;
      const m = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(v.trim());
      const literal = m ? m[2] : v;
      if (!isLiteral(literal)) continue;
      out.push({ literal, name: /^authorization$/i.test(h) ? (m && /^basic$/i.test(m[1]) ? 'BASIC_AUTH' : 'API_TOKEN') : varName(h), kind: 'header', where: h });
    }
    for (const rec of [api.query, api.form, api.multipart]) {
      for (const [k, v] of Object.entries(rec ?? {})) if (CREDENTIAL_NAME.test(k) && isLiteral(v)) out.push({ literal: v, name: varName(k), kind: 'body', where: k });
    }
    const walk = (v: unknown, key: string) => {
      if (typeof v === 'string') {
        if (key && CREDENTIAL_NAME.test(key) && isLiteral(v)) out.push({ literal: v, name: varName(key), kind: 'body', where: key });
        else if (v.trim().startsWith('{')) {
          try {
            walk(JSON.parse(v), key);
          } catch {
            // not JSON
          }
        }
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(api.body, '');
    if (api.graphql?.variables) walk(api.graphql.variables, '');
  }
  return out;
}

/** Credentials in source text that was not converted (TODO lines): `password = "x"`, `"apiKey": "x"`, `Bearer x`. */
function textHits(text: string): Hit[] {
  const out: Hit[] = [];
  const kv = /\b([\w-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key)[\w-]*)["']?\s*[:=,]\s*\\?["']([^"'\\$\n]{3,})\\?["']/gi;
  for (const m of text.matchAll(kv)) out.push({ literal: m[2], name: varName(m[1]), kind: 'source-text', where: m[1] });
  for (const m of text.matchAll(/\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/g)) if (!m[1].includes('${')) out.push({ literal: m[1], name: 'API_TOKEN', kind: 'source-text', where: 'Bearer token' });
  return out;
}

export interface ScrubbedJourney {
  ez: string;
  todo: TodoItem[];
  findings: CredentialFinding[];
}

/**
 * The `.ez` (and TODO items) of one imported test with every credential-like literal replaced by a variable.
 * `names` (literal -> variable) is shared across the journeys of one import, so one secret gets one name.
 */
export function scrubJourney(c: ConvertedJourney, names: Map<string, string> = new Map()): ScrubbedJourney {
  const hits = [...hitsOf(c.journey), ...textHits([c.ez, ...c.todo.map((t) => t.original)].join('\n'))];
  const findings: CredentialFinding[] = [];
  const taken = new Set(names.values());
  let ez = c.ez;
  let todo = c.todo;
  const seen = new Set<string>();
  for (const h of hits.sort((a, b) => b.literal.length - a.literal.length)) {
    if (seen.has(h.literal)) continue;
    seen.add(h.literal);
    let v = names.get(h.literal);
    if (!v) {
      v = h.name;
      for (let i = 2; taken.has(v); i++) v = `${h.name}_${i}`;
      names.set(h.literal, v);
      taken.add(v);
    }
    const before = ez;
    ez = replaceLiteral(ez, h.literal, v);
    todo = todo.map((t) => ({ ...t, original: replaceLiteral(t.original, h.literal, v!) }));
    if (ez !== before || todo.some((t, i) => t.original !== c.todo[i]?.original)) {
      findings.push({ journeyId: c.id, file: c.file, variable: v, kind: h.kind, where: h.where, hint: hintFor(v) });
    }
  }
  return { ez, todo, findings };
}

/** Apply every literal -> variable replacement of an import to a text (TODO originals, warnings). */
export function scrubText(text: string, names: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [literal, v] of [...names].sort((a, b) => b[0].length - a[0].length)) out = replaceLiteral(out, literal, v);
  return out;
}

/** Markdown section of the import report listing the variables to provide. */
export function credentialsMarkdown(findings: CredentialFinding[]): string[] {
  if (!findings.length) return [];
  const vars = [...new Set(findings.map((f) => f.variable))];
  return [
    '## Credentials replaced by variables', '',
    'Credential-like literals of the source (passwords, tokens, API keys, Authorization values) were not copied into the journeys.',
    'Each one is a `${NAME}` variable now; provide it from a secret store, for example in eztest.config.yaml:', '',
    '```yaml', 'vars:', ...vars.map((v) => `  ${v}: secret://env/${v}`), '```', '',
    '| Variable | Journey | Source | Held in |', '|---|---|---|---|',
    ...findings.map((f) => `| \`${f.variable}\` | \`${f.journeyId}\` | ${f.file} | ${f.kind}: ${f.where.replace(/\|/g, '\\|')} |`),
  ];
}
