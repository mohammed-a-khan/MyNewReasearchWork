/**
 * Editor language services for the Studio: formatting, per-line explanations
 * (hover docs) and the project vocabulary used for autocomplete (roles,
 * connections, document checks, data entities, tags, variables).
 */
import YAML from 'yaml';
import { INTENT_RULES, conditionToText, parseCondition, parseIntent, matchedRule, IntentParseError, loadJourneyFile } from '../intent/index.js';
import { Step, type Condition } from '../core/index.js';
import { findJourneyFiles } from '../cli/journeys.js';
import { categoryOf, type JourneyFormat } from './authoring.js';

const HEADER = /^(journey|name|id|tags|role|requirements?|risk|base\s*url|variables|vars|description|lenses|data|requires|depends\s*on)\s*:\s*(.*)$/i;
const EXPECT = /^(?:(?:then|and|also)\s+)?(?:expect|verify)\s+(?:that\s+)?(.+)$/i;

const HEADER_DOCS: Record<string, string> = {
  journey: 'The journey name (required). The id defaults to a slug of it.',
  name: 'The journey name (same as Journey:).',
  id: 'A stable journey id, used by runs, history and traceability.',
  tags: 'Tags such as @smoke @orders, used to select journeys to run.',
  role: 'The Identity Vault role the journey runs as.',
  requirement: 'Requirement or work-item ids for traceability.',
  requirements: 'Requirement or work-item ids for traceability.',
  risk: 'Risk weight 1 (low) to 5 (critical), used by readiness and impact ranking.',
  'base url': 'Base URL for relative paths in this journey.',
  baseurl: 'Base URL for relative paths in this journey.',
  variables: 'Variables available as ${name}, e.g. currency=EUR, qty=2.',
  vars: 'Variables available as ${name}, e.g. currency=EUR, qty=2.',
  description: 'What this journey proves.',
  lenses: 'Lenses run after every step: a11y, security, visual (add :warn to report without failing).',
  data: 'Declared test data, e.g. Customer as customer where region=EU.',
  requires: 'Data-state preconditions checked before the journey runs; a miss is reported as a data problem, e.g. db demo "SELECT id FROM customers WHERE region = \'EU\'" has rows; variable PAYMENT_KEY.',
  'depends on': 'Prerequisite journeys that must pass first, with the ledger values handed over, e.g. create-order with orderNumber.',
};

/** Tidy journey text without changing its meaning. `.ez` comments and YAML comments are kept. */
export function formatText(text: string, format: JourneyFormat): string {
  if (format === 'json') return JSON.stringify(JSON.parse(text), null, 2) + '\n';
  if (format === 'yaml') {
    const doc = YAML.parseDocument(text);
    if (doc.errors.length) throw doc.errors[0];
    return doc.toString({ indent: 2, lineWidth: 0 });
  }
  const out: string[] = [];
  let inSteps = false;
  let blank = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      blank++;
      continue;
    }
    const isComment = line.startsWith('#') || line.startsWith('//');
    const isHeader = !inSteps && !isComment && HEADER.test(line);
    const isExpect = inSteps && !isComment && EXPECT.test(line);
    if (!isComment && !isHeader && !isExpect && !inSteps) {
      // First step: one blank line separates it from the headers (a comment right above it stays attached).
      inSteps = true;
      const last = out[out.length - 1];
      if (last !== undefined && HEADER.test(last)) blank = Math.max(blank, 1);
    }
    if (blank && out.length) out.push('');
    blank = 0;
    if (isHeader) {
      const m = HEADER.exec(line)!;
      const key = m[1].replace(/\s+/g, ' ');
      out.push(`${key[0].toUpperCase()}${key.slice(1)}: ${m[2].trim()}`);
    } else if (isExpect) out.push(`  ${line}`);
    else if (isComment) out.push(/^\s/.test(raw) && inSteps ? `  ${line}` : line);
    else out.push(line);
  }
  return out.join('\n') + '\n';
}

export interface LineExplanation {
  kind: 'step' | 'expect' | 'header' | 'comment' | 'blank' | 'error';
  /** Markdown-free one-line summary. */
  summary: string;
  action?: string;
  target?: string;
  value?: string;
  captureAs?: string;
  optional?: boolean;
  postconditions?: string[];
  rule?: { name: string; category: string; example: string; keywords: string[] };
  message?: string;
  suggestions?: string[];
}

function describeCondition(c: Condition): string {
  try {
    return conditionToText(c);
  } catch {
    return c.type;
  }
}

/** Explain one `.ez` line: what it does, which grammar rule it uses, or why it does not parse. */
export function explainLine(line: string): LineExplanation {
  const t = line.trim();
  if (!t) return { kind: 'blank', summary: '' };
  if (t.startsWith('#') || t.startsWith('//')) return { kind: 'comment', summary: 'Comment' };
  const h = HEADER.exec(t);
  if (h) {
    const key = h[1].toLowerCase().replace(/\s+/g, ' ');
    return { kind: 'header', summary: `${h[1]} header`, message: HEADER_DOCS[key] ?? '' };
  }
  const e = EXPECT.exec(t);
  if (e) {
    try {
      const c = parseCondition(e[1].replace(/[.;]+$/, ''));
      return { kind: 'expect', summary: `Post-condition (${c.type}) of the step above`, postconditions: [describeCondition(c)] };
    } catch (err) {
      return { kind: 'error', summary: 'Expectation not understood', message: (err as Error).message, suggestions: [] };
    }
  }
  try {
    const step = Step.parse({ ...parseIntent(t) });
    const first = (/^([\w-]+)/.exec(t)?.[1] ?? '').toLowerCase();
    const candidates = INTENT_RULES.filter((r) => {
      try {
        return Step.parse(parseIntent(r.example)).action === step.action;
      } catch {
        return false;
      }
    });
    const rule = matchedRule(t) ?? candidates.find((r) => r.keywords.some((k) => k.toLowerCase() === first)) ?? candidates[0];
    const target = step.target?.description;
    const parts = [step.action, target, step.value !== undefined ? `"${step.value}"` : undefined].filter(Boolean);
    return {
      kind: 'step',
      summary: parts.join(' · '),
      action: step.action,
      target,
      value: step.value,
      captureAs: step.captureAs,
      optional: step.optional,
      postconditions: step.postconditions.map(describeCondition),
      rule: rule ? { name: rule.name, category: categoryOf(rule), example: rule.example, keywords: rule.keywords } : undefined,
    };
  } catch (err) {
    const suggestions = err instanceof IntentParseError ? err.suggestions : [];
    return { kind: 'error', summary: 'Step not understood', message: (err as Error).message, suggestions };
  }
}

export interface Vocabulary {
  roles: string[];
  connections: string[];
  documents: string[];
  entities: string[];
  tags: string[];
  variables: string[];
  lenses: string[];
}

const uniq = (xs: Iterable<string>) => [...new Set(xs)].filter(Boolean).sort((a, b) => a.localeCompare(b));

/** Names the editor offers for autocomplete, from the config and all journeys. */
export async function vocabulary(cwd: string, journeysDir: string, config?: Record<string, unknown>): Promise<Vocabulary> {
  const cfg = (config ?? {}) as {
    identity?: { roles?: Record<string, unknown> };
    db?: { connections?: Record<string, unknown> };
    documents?: Record<string, unknown>;
    data?: { entities?: Record<string, unknown> };
  };
  const tags = new Set<string>();
  const variables = new Set<string>();
  const roles = new Set(Object.keys(cfg.identity?.roles ?? {}));
  try {
    for (const f of await findJourneyFiles([journeysDir], cwd)) {
      try {
        const j = await loadJourneyFile(f);
        j.tags.forEach((t) => tags.add(t));
        Object.keys(j.variables).forEach((v) => variables.add(v));
        j.data.forEach((d) => variables.add(d.as));
        j.steps.forEach((s) => s.captureAs && variables.add(s.captureAs));
        if (j.role) roles.add(j.role);
      } catch {
        // unparsable journeys contribute nothing
      }
    }
  } catch {
    // no journeys directory yet
  }
  return {
    roles: uniq(roles),
    connections: uniq(Object.keys(cfg.db?.connections ?? {})),
    documents: uniq(Object.keys(cfg.documents ?? {})),
    entities: uniq(Object.keys(cfg.data?.entities ?? {})),
    tags: uniq(tags),
    variables: uniq(variables),
    lenses: ['a11y', 'security', 'visual'],
  };
}
