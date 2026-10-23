/**
 * Alert channels. Alerts fire on health changes only (down / recovered) and
 * carry no secrets: every free-text field passes through redaction.
 */
import { EzTestError, NotSupportedError } from '../core/index.js';
import { redactText } from '../mocks/redact.js';
import type { JourneyMonitorState } from './state.js';

export interface MonitorAlert {
  /** Stable dedupe key: journey + kind + time of the health change. */
  id: string;
  kind: 'down' | 'recovered';
  journeyId: string;
  journeyName: string;
  status: 'down' | 'up';
  at: string;
  consecutiveFailures: number;
  failingStep?: { stepId: string; intent: string; message?: string };
  triageHint?: string;
  runDir?: string;
  uptimePct: number | null;
  /** One-line human text (Slack / Teams `text`). */
  text: string;
}

export type AlertChannel =
  | { type: 'webhook'; url: string; timeoutMs?: number; headers?: Record<string, string>; name?: string }
  | { type: 'callback'; fn: (alert: MonitorAlert) => void | Promise<void>; name?: string };

export function channelName(c: AlertChannel, i: number): string {
  return c.name ?? `${c.type}#${i + 1}`;
}

export function validateChannels(channels: AlertChannel[]): void {
  channels.forEach((c, i) => {
    if (c.type === 'webhook') {
      let u: URL;
      try {
        u = new URL(c.url);
      } catch {
        throw new EzTestError(`alerts[${i}]: invalid webhook URL`, 'MONITOR_ALERT_INVALID');
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new NotSupportedError(`webhook protocol ${u.protocol}`);
    } else if (c.type !== 'callback') {
      throw new NotSupportedError(`alert channel type "${String((c as { type: unknown }).type)}"`);
    }
  });
}

export function buildAlert(
  kind: 'down' | 'recovered',
  js: JourneyMonitorState,
  extra: { at: string; triageHint?: string; runDir?: string },
): MonitorAlert {
  const failingStep = kind === 'down' && js.lastFailingStep
    ? {
        stepId: js.lastFailingStep.stepId,
        intent: redactText(js.lastFailingStep.intent),
        message: js.lastFailingStep.message ? redactText(js.lastFailingStep.message).slice(0, 500) : undefined,
      }
    : undefined;
  const hint = extra.triageHint ? redactText(extra.triageHint).slice(0, 500) : undefined;
  const name = redactText(js.name);
  const text =
    kind === 'down'
      ? `:red_circle: EZTest monitor DOWN: ${name} failed ${js.consecutiveFailures} time(s) in a row` +
        (failingStep ? ` at step "${failingStep.stepId}" (${failingStep.intent})${failingStep.message ? `: ${failingStep.message}` : ''}` : '') +
        (hint ? ` | triage: ${hint}` : '') +
        (extra.runDir ? ` | evidence: ${extra.runDir}` : '')
      : `:large_green_circle: EZTest monitor RECOVERED: ${name} is passing again` + (extra.runDir ? ` | evidence: ${extra.runDir}` : '');
  return {
    id: `${js.journeyId}:${kind}:${js.lastChange ?? extra.at}`,
    kind,
    journeyId: js.journeyId,
    journeyName: name,
    status: kind === 'down' ? 'down' : 'up',
    at: extra.at,
    consecutiveFailures: js.consecutiveFailures,
    failingStep,
    triageHint: hint,
    runDir: extra.runDir,
    uptimePct: js.uptimePct,
    text,
  };
}

export async function sendWebhook(c: Extract<AlertChannel, { type: 'webhook' }>, alert: MonitorAlert): Promise<void> {
  const res = await fetch(c.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(c.headers ?? {}) },
    // `text` makes the payload render in Slack incoming webhooks and Teams connectors.
    body: JSON.stringify({ text: alert.text, eztest: alert }),
    signal: AbortSignal.timeout(c.timeoutMs ?? 10_000),
  });
  await res.arrayBuffer().catch(() => undefined);
  if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
}

/** Deliver to every channel; failures are collected, never thrown, so one bad channel cannot block others. */
export async function deliverAlert(
  channels: AlertChannel[],
  alert: MonitorAlert,
): Promise<{ delivered: string[]; failed: Array<{ channel: string; error: string }> }> {
  const delivered: string[] = [];
  const failed: Array<{ channel: string; error: string }> = [];
  await Promise.all(
    channels.map(async (c, i) => {
      const name = channelName(c, i);
      try {
        if (c.type === 'webhook') await sendWebhook(c, alert);
        else await c.fn(alert);
        delivered.push(name);
      } catch (e) {
        failed.push({ channel: name, error: redactText((e as Error).message) });
      }
    }),
  );
  return { delivered, failed };
}
