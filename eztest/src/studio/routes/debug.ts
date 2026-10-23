/**
 * Studio routes for the live debugger. Commands are JSON POSTs; events and
 * live-view frames are SSE. Mount under the Studio's authenticated `/api/`
 * dispatcher (see docs/studio-debug-trace.md).
 */
import { Condition, type LocatorCandidate } from '../../core/index.js';
import { parseCondition } from '../../intent/conditions.js';
import { parseInputEvent, type BreakpointInput, type ValidateInput } from '../../runner/index.js';
import type { DebugSessionManager, DebugStartRequest } from '../debug-session.js';
import { HttpError } from '../runs.js';
import { guarded, num, optInt, str, type RouteDef, type SseSink } from './types.js';

const COMMANDS = ['pause', 'resume', 'stepOver', 'stepInto', 'runToStep', 'retry', 'skip'] as const;

function breakpointFrom(body: Record<string, unknown>): BreakpointInput {
  const stepIndex = optInt(body.stepIndex, 'stepIndex');
  const stepId = typeof body.stepId === 'string' && body.stepId ? body.stepId : undefined;
  // Code journeys (eztest/sdk): a breakpoint on a source line of a file.
  const line = optInt(body.line, 'line');
  const file = typeof body.file === 'string' && body.file ? body.file : undefined;
  if (stepIndex === undefined && stepId === undefined && line === undefined) throw new HttpError(400, 'A breakpoint needs stepIndex, stepId or line');
  let condition: Condition | undefined;
  if (typeof body.condition === 'string' && body.condition.trim()) condition = parseCondition(body.condition.trim());
  else if (body.condition && typeof body.condition === 'object') condition = Condition.parse(body.condition);
  return {
    ...(typeof body.journeyId === 'string' && body.journeyId ? { journeyId: body.journeyId } : {}),
    ...(stepIndex !== undefined ? { stepIndex } : {}),
    ...(stepId ? { stepId } : {}),
    ...(line !== undefined ? { line, ...(file ? { file } : {}) } : {}),
    ...(condition ? { condition } : {}),
    ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
  };
}

function stepInput(v: unknown, name: string): string | Record<string, unknown> {
  if (typeof v === 'string' && v.trim()) return v;
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  throw new HttpError(400, `"${name}" must be an .ez step line or a step object`);
}

/** Frame SSE: base64 JPEG events, at most `fps` per client, dropped while the client is slow. */
function frameStream(manager: DebugSessionManager, fps: number) {
  return (sink: SseSink) => {
    const minGap = 1000 / fps;
    let last = 0;
    let blocked = false;
    let seq = 0;
    const off = manager.subscribeFrames((f) => {
      const now = Date.now();
      if (blocked || now - last < minGap) return false;
      last = now;
      const ok = sink.send({ id: ++seq, event: 'frame', data: { seq: f.seq, at: f.at, metadata: f.metadata, jpeg: f.data } });
      if (!ok) {
        // The host's socket buffer is full: drop frames until the next interval.
        blocked = true;
        setTimeout(() => (blocked = false), minGap * 2);
      }
      return ok;
    });
    return off;
  };
}

export function debugRoutes(manager: DebugSessionManager): RouteDef[] {
  const ctl = () => manager.require().controller;
  const route = (method: RouteDef['method'], path: RouteDef['path'], handler: RouteDef['handler']): RouteDef => ({ method, path, handler: guarded(handler) });
  return [
    route('POST', '/api/debug/sessions', async ({ body }) => {
      const breakpoints = Array.isArray(body.breakpoints) ? body.breakpoints.map((b) => breakpointFrom((b ?? {}) as Record<string, unknown>)) : undefined;
      const req: DebugStartRequest = {
        journey: str(body.journey, 'journey'),
        breakpoints,
        pauseOnFailure: typeof body.pauseOnFailure === 'boolean' ? body.pauseOnFailure : undefined,
        pauseAtStart: typeof body.pauseAtStart === 'boolean' ? body.pauseAtStart : undefined,
        timeTravel: typeof body.timeTravel === 'boolean' ? body.timeTravel : undefined,
        browser: body.browser as DebugStartRequest['browser'],
        headed: body.headed === true,
      };
      const s = await manager.start(req);
      return { status: 202, json: { id: s.id, journeyId: s.journeyId, events: '/api/debug/events', frames: '/api/debug/frames' } };
    }),
    route('GET', '/api/debug/session', () => {
      const s = manager.current;
      if (!s) return { json: { state: 'idle' } };
      return { json: { id: s.id, journeyId: s.journeyId, state: s.state, startedAt: s.startedAt, result: s.result, debug: s.controller.state() } };
    }),
    route('POST', '/api/debug/stop', async () => {
      await manager.stop();
      return { json: { ok: true, state: manager.current?.state ?? 'idle' } };
    }),
    route('POST', '/api/debug/command', ({ body }) => {
      const command = str(body.command, 'command');
      if (!(COMMANDS as readonly string[]).includes(command)) throw new HttpError(400, `command must be one of ${COMMANDS.join(', ')}`);
      const c = ctl();
      switch (command as (typeof COMMANDS)[number]) {
        case 'pause': c.pause(); break;
        case 'resume': c.resume(); break;
        case 'stepOver': c.stepOver(); break;
        case 'stepInto': c.stepInto(); break;
        case 'runToStep': {
          const stepIndex = optInt(body.stepIndex, 'stepIndex');
          const stepId = typeof body.stepId === 'string' ? body.stepId : undefined;
          const line = optInt(body.line, 'line');
          const file = typeof body.file === 'string' && body.file ? body.file : undefined;
          c.runToStep({ stepIndex, stepId, ...(line !== undefined ? { line, ...(file ? { file } : {}) } : {}) });
          break;
        }
        case 'retry': c.retry(body.step === undefined ? undefined : stepInput(body.step, 'step') as never); break;
        case 'skip': c.skip(); break;
      }
      return { json: { ok: true, debug: c.state() } };
    }),
    route('GET', '/api/debug/breakpoints', () => ({ json: { breakpoints: ctl().breakpoints } })),
    route('POST', '/api/debug/breakpoints', ({ body }) => ({ status: 201, json: ctl().addBreakpoint(breakpointFrom(body)) })),
    route('DELETE', /^\/api\/debug\/breakpoints\/([^/]+)$/, ({ params }) => {
      if (!ctl().removeBreakpoint(params[0])) throw new HttpError(404, `No breakpoint ${params[0]}`);
      return { json: { ok: true } };
    }),
    route('POST', '/api/debug/edit', ({ body }) => {
      const c = ctl();
      const step = c.replaceStep(stepInput(body.step, 'step') as never, { index: optInt(body.index, 'index') });
      if (body.retry === true) c.retry();
      return { json: { step, debug: c.state() } };
    }),
    route('POST', '/api/debug/evaluate', async ({ body }) => {
      const result = await ctl().evaluate(stepInput(body.step, 'step') as never, { commit: body.commit === true });
      return { json: { result } };
    }),
    route('POST', '/api/debug/pick', async ({ body }) => {
      const action = body.action === undefined ? undefined : String(body.action);
      if (action !== undefined && !['click', 'fill', 'select', 'check', 'hover', 'dblclick'].includes(action)) throw new HttpError(400, 'Unknown action');
      return { json: await ctl().pick({ x: num(body.x, 'x'), y: num(body.y, 'y') }, { action: action as never, value: typeof body.value === 'string' ? body.value : undefined }) };
    }),
    route('POST', '/api/debug/validate', async ({ body }) => {
      let input: ValidateInput;
      if (typeof body.target === 'string' && body.target.trim()) input = { target: body.target };
      else if (body.candidate && typeof body.candidate === 'object') input = body.candidate as LocatorCandidate;
      else throw new HttpError(400, 'Give "target" (.ez target text) or "candidate" (locator)');
      return { json: await ctl().validate(input, { highlight: body.highlight !== false }) };
    }),
    route('POST', '/api/debug/input', async ({ body }) => {
      await ctl().input(parseInputEvent(body));
      return { json: { ok: true } };
    }),
    route('GET', '/api/debug/events', ({ query }) => {
      const s = manager.require();
      const after = Number(query.get('after') ?? 0) || 0;
      return {
        sse: (sink) => {
          let closed = false;
          const send = (e: { seq: number; type: string; data: Record<string, unknown> }) => {
            if (closed) return;
            sink.send({ id: e.seq, data: { type: e.type, ...e.data } });
            if (e.type === 'done') {
              closed = true;
              sink.close();
            }
          };
          for (const e of s.events) if (e.seq > after) send(e);
          return closed ? () => undefined : manager.subscribe(send);
        },
      };
    }),
    route('GET', '/api/debug/frames', ({ query }) => {
      manager.require();
      const fps = Math.max(1, Math.min(15, Number(query.get('fps') ?? 5) || 5));
      return { sse: frameStream(manager, fps) };
    }),
  ];
}
