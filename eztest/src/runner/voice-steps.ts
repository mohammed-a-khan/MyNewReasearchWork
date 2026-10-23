/**
 * Phone-call steps (action `voice`):
 *   place         Place a call to "+1555..." [from ...] [saying "..."] [and press "1w2"] as call
 *   wait          Wait for a call to "+1555..." [from ...] [within 2 minutes] [and capture the spoken code as otp]
 *   expectSaid    Expect the call call to say "Press 1 for billing" then "Press 2 for support"
 *   expectDigits  Expect the call call to have sent the digits "1w2"
 * The call value (`${call.transcript}`, `${call.text}` with spoken digits
 * joined, `${call.prompts}`, `${call.digits}`, `${call.status}`) is stored in
 * the ledger and as evidence, masked.
 */
import { EzTestError, evaluateExpression, type Step } from '../core/index.js';
import { callValue, normalizeSpokenText, type VoiceCall } from '../messaging/voice.js';
import type { ActionOutcome } from './actions.js';
import { maskDeep } from './dom.js';
import { safeName } from './evidence.js';
import type { RunOptions, StepContext } from './types.js';

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Does the transcript say `want` (case, punctuation and spoken-digit insensitive)? Returns where. */
export function saidAt(transcript: string, want: string, from = 0): number {
  const hay = squash(normalizeSpokenText(transcript));
  const needle = squash(normalizeSpokenText(want));
  if (!needle) return -1;
  return hay.indexOf(needle, from);
}

async function store(ctx: StepContext, step: Step, value: Record<string, unknown>, what: string): Promise<string> {
  const ref = await ctx.evidence.store('data', `calls/${safeName(ctx.journey.id)}/${safeName(step.id)}.json`, JSON.stringify(value, null, 2), { journeyId: ctx.journey.id, stepId: step.id, description: what });
  return ref.id;
}

function callFromLedger(ctx: StepContext, name: string): Record<string, unknown> {
  const v = evaluateExpression(name, ctx.vars());
  if (!v || typeof v !== 'object' || !('transcript' in (v as object))) throw new EzTestError(`"${name}" is not a phone call (capture one with "Place a call ..." or "Wait for a call ... as ${name}")`, 'INVALID_INPUT');
  return v as Record<string, unknown>;
}

export async function voiceAction(step: Step, ctx: StepContext, opts: RunOptions): Promise<ActionOutcome> {
  const a = step.args ?? {};
  const s = (v: unknown) => (v === undefined ? undefined : ctx.interpolate(String(v)));
  const mask = ctx.session?.mask ?? ((x: string) => x);
  const op = String(a.op ?? '');
  if (op === 'expectSaid' || op === 'expectDigits') {
    const call = callFromLedger(ctx, String(a.call ?? 'call'));
    if (op === 'expectDigits') {
      const want = s(a.digits) ?? '';
      const got = String(call.digits ?? '');
      if (got.replace(/[wW]/g, '') !== want.replace(/[wW]/g, '')) throw new EzTestError(`call ${String(call.id)} sent the digits "${got}", expected "${want}"`, 'ASSERTION');
      return {};
    }
    const texts = (a.texts as string[] | undefined ?? []).map((t) => ctx.interpolate(t));
    const transcript = String(call.transcript ?? '');
    let at = 0;
    for (const t of texts) {
      const i = saidAt(transcript, t, a.ordered ? at : 0);
      if (i < 0) {
        const heard = transcript.length > 300 ? `${transcript.slice(0, 300)}...` : transcript;
        throw new EzTestError(`call ${String(call.id)} did not say "${t}"${a.ordered && at > 0 ? ' after the previous prompt' : ''}; transcript (${String(call.transcriptSource ?? 'provider')}): "${mask(heard)}"`, 'ASSERTION');
      }
      at = i + 1;
    }
    return {};
  }
  if (!opts.voice) throw new EzTestError('No voice provider configured (config voice: { provider: twilio, ... } or RunOptions.voice)', 'NO_HANDLER');
  const timeoutMs = Number(a.timeoutMs ?? 180_000);
  let call: VoiceCall;
  if (op === 'place') {
    const placed = await opts.voice.placeCall({ to: s(a.to)!, ...(a.from ? { from: s(a.from)! } : {}), ...(a.say ? { say: s(a.say)! } : {}), ...(a.digits ? { digits: s(a.digits)! } : {}) });
    call = await opts.voice.complete(placed, { timeoutMs });
  } else if (op === 'wait') {
    const since = Date.now() - Number(a.lookbackMs ?? 120_000);
    const found = await opts.voice.waitForCall({ ...(a.to ? { to: s(a.to) } : {}), ...(a.from ? { from: s(a.from) } : {}), since, timeoutMs });
    call = await opts.voice.complete(found, { timeoutMs });
  } else throw new EzTestError(`voice op "${op}"`, 'NOT_SUPPORTED');
  if (call.status !== 'completed') throw new EzTestError(`call ${call.id} to ${call.to} ended "${call.status}"`, 'VOICE_CALL');
  const value = maskDeep(callValue(call), mask) as Record<string, unknown>;
  const key = step.captureAs ?? 'call';
  ctx.ledger.set(key, value);
  const captured: Record<string, unknown> = { [key]: value };
  if (a.codeAs) {
    const n = a.codeDigits ? Number(a.codeDigits) : undefined;
    const re = n ? new RegExp(`(?<!\\d)(\\d{${n}})(?!\\d)`) : /(?<!\d)(\d{4,8})(?!\d)/;
    const m = re.exec(String(value.text ?? ''));
    if (!m) throw new EzTestError(`no ${n ? `${n}-digit ` : ''}code in the call transcript: "${String(value.transcript ?? '')}"`, 'NO_MATCH');
    ctx.ledger.set(String(a.codeAs), m[1]);
    captured[String(a.codeAs)] = m[1];
  }
  const ev = await store(ctx, step, value, `phone call ${op === 'place' ? 'placed' : 'received'}`);
  return { captured, evidence: [ev] };
}
