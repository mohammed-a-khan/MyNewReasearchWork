/**
 * Production-safety guard: a journey only runs as a monitor when it is
 * explicitly marked safe, and journeys that look like they write data need an
 * explicit `allowWrites`.
 */
import type { Journey, Step } from '../core/index.js';
import { EzTestError } from '../core/index.js';

export const MONITOR_SAFE_TAGS = ['monitor', '@monitor', 'monitor-safe', '@monitor-safe'];

export interface MonitorSafetyOptions {
  /** Journey ids allowed even without a monitor tag. */
  allowJourneys?: string[];
  /** Permit journeys with write-like steps. */
  allowWrites?: boolean;
}

export interface WriteFinding {
  journeyId: string;
  stepId?: string;
  reason: string;
}

const SUBMIT_WORDS = /\b(submit|save|place|create|add|delete|remove|confirm|pay|purchase|checkout|order|send|update|apply|approve|post|publish|register|sign up|transfer|book)\b/i;
const INPUT_ACTIONS = new Set(['fill', 'select', 'check', 'uncheck', 'upload', 'clear']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SQL_WRITE = /\b(insert|update|delete|merge|upsert|drop|alter|create|truncate|grant|revoke|call|exec|execute|replace)\b/i;

function stepText(s: Step): string {
  return `${s.intent} ${s.target?.description ?? ''} ${s.target?.locators.map((l) => `${l.value} ${l.name ?? ''}`).join(' ') ?? ''}`;
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
}

/** Static scan for steps that may change data in the system under test. */
export function findWriteSteps(journey: Journey): WriteFinding[] {
  const out: WriteFinding[] = [];
  let pendingInput: Step | undefined;
  for (const s of journey.steps) {
    if (s.action === 'api') {
      const method = (s.api?.method ?? 'GET').toUpperCase();
      if (WRITE_METHODS.has(method)) out.push({ journeyId: journey.id, stepId: s.id, reason: `api ${method} ${s.api?.url ?? ''}`.trim() });
    } else if (s.action === 'db') {
      const sql = stripSqlComments(s.db?.sql ?? '');
      if (!/^select\b/i.test(sql) || SQL_WRITE.test(sql) || /;\s*\S/.test(sql)) {
        out.push({ journeyId: journey.id, stepId: s.id, reason: `db step is not a single read-only SELECT` });
      }
    } else if (s.action === 'upload') {
      out.push({ journeyId: journey.id, stepId: s.id, reason: 'file upload' });
    } else if (s.action === 'custom') {
      out.push({ journeyId: journey.id, stepId: s.id, reason: `custom step "${s.handler ?? '?'}" (effects unknown)` });
    }
    if (INPUT_ACTIONS.has(s.action)) pendingInput = s;
    else if (pendingInput && ((s.action === 'click' || s.action === 'dblclick') && SUBMIT_WORDS.test(stepText(s)))) {
      out.push({ journeyId: journey.id, stepId: s.id, reason: `form submit after input (step ${pendingInput.id} then "${s.intent}")` });
      pendingInput = undefined;
    } else if (pendingInput && s.action === 'press' && /^enter$/i.test(s.value ?? '')) {
      out.push({ journeyId: journey.id, stepId: s.id, reason: `Enter pressed after input (step ${pendingInput.id})` });
      pendingInput = undefined;
    }
  }
  for (const d of journey.data) {
    if (d.strategy === 'create' || d.strategy === 'find-or-create') {
      out.push({ journeyId: journey.id, reason: `test data "${d.as}" uses strategy "${d.strategy}" (may create records)` });
    }
  }
  return out;
}

export function isMonitorTagged(j: Journey): boolean {
  return j.tags.some((t) => MONITOR_SAFE_TAGS.includes(t.toLowerCase()));
}

/** Throw unless every journey is safe to run against production. */
export function assertMonitorSafe(journeys: Journey[], opts: MonitorSafetyOptions = {}): void {
  if (!journeys.length) throw new EzTestError('Monitor: no journeys given', 'MONITOR_NO_JOURNEYS');
  const problems: string[] = [];
  for (const j of journeys) {
    if (!isMonitorTagged(j) && !(opts.allowJourneys ?? []).includes(j.id)) {
      problems.push(`journey "${j.id}" is not tagged ${MONITOR_SAFE_TAGS.slice(0, 2).join(' / ')} / @monitor-safe and not in allowJourneys`);
    }
    if (!opts.allowWrites) {
      for (const w of findWriteSteps(j)) problems.push(`journey "${j.id}"${w.stepId ? ` step "${w.stepId}"` : ''}: ${w.reason} — needs allowWrites: true`);
    }
  }
  if (problems.length) {
    throw new EzTestError(`Refusing to monitor unsafe journeys:\n- ${problems.join('\n- ')}`, 'MONITOR_UNSAFE', { problems });
  }
}
