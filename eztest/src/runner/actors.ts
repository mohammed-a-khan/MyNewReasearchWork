/**
 * Multi-actor journeys (docs/multi-actor.md): several users in one journey,
 * each with an isolated browser context and session (cookies, storage, tabs,
 * dialogs, network log), or a native-app user on a platform driver.
 *
 *   Actors: manager as approver, customer as shopper
 *   As customer:
 *     Open /orders/new
 *     Click the "Submit" button
 *   As manager:
 *     Click the "Approve" button
 *   As customer:
 *     Expect the page contains "Approved"
 *
 * Steps outside any `As` block run as the primary actor: the first declared
 * actor, else the first actor named in the steps, else "default". "Switch to
 * user "bob"" makes the following steps of the same list run as bob.
 * "In parallel:" runs its branches (usually As blocks) at the same time.
 *
 * This module holds the static analysis (which actors a journey has) and the
 * contract between the flow engine and the journey runner, which owns the
 * contexts. Nothing here evaluates user content.
 */
import type { Actor, Journey, Step } from '../core/index.js';
import type { BrowserContext } from '../browser/index.js';
import type { BrowserSession } from './session.js';

/** Name of the actor of a journey that declares none and names none in its steps. */
export const DEFAULT_ACTOR = 'default';

/** Actor names used by `As <name>` / `Switch to user` steps (static names only; `${var}` names are resolved at run time). */
export function actorNamesInSteps(steps: Step[] | undefined, out: string[] = []): string[] {
  for (const s of steps ?? []) {
    if (s.action === 'actor' && s.value && !s.value.includes('${') && !out.includes(s.value)) out.push(s.value);
    actorNamesInSteps(s.steps, out);
    actorNamesInSteps(s.else, out);
    actorNamesInSteps(s.catch, out);
  }
  return out;
}

/** True when the journey has actors (declared, or used by its steps). */
export function isMultiActor(journey: Pick<Journey, 'actors' | 'steps'>): boolean {
  if (journey.actors && Object.keys(journey.actors).length) return true;
  const walk = (list: Step[] | undefined): boolean => (list ?? []).some((s) => s.action === 'actor' || s.action === 'parallel' || walk(s.steps) || walk(s.else) || walk(s.catch));
  return walk(journey.steps);
}

/** Every actor of the journey, declared first (in order), then the ones only named in steps. */
export function actorNames(journey: Pick<Journey, 'actors' | 'steps'>): string[] {
  return actorNamesInSteps(journey.steps, [...Object.keys(journey.actors ?? {})]);
}

/** The actor whose context is the journey's first one (steps outside any As block run as it). */
export function primaryActor(journey: Pick<Journey, 'actors' | 'steps'>): string {
  return actorNames(journey).find((n) => (journey.actors?.[n]?.platform ?? 'web') === 'web') ?? DEFAULT_ACTOR;
}

/** The declaration of an actor (an undeclared actor is a plain web user). */
export function actorSpec(journey: Pick<Journey, 'actors'>, name: string): Actor {
  return journey.actors?.[name] ?? {};
}

/** One live actor of a journey attempt. */
export interface ActorSlot {
  name: string;
  spec: Actor;
  /** 'web', or the native platform the actor's blocks run on. */
  platform: string;
  /** Web actors: their own context and session. */
  context?: BrowserContext;
  session?: BrowserSession;
  /** The step this actor is running (network / console attribution). */
  currentStepId?: string;
  /** Role of the last successful login (re-login after a mid-journey session expiry). */
  loginRole?: string;
  relogged?: boolean;
  /** The actor's declared role signed in (on its first As block or Switch). */
  signedIn?: boolean;
}

/** What the flow engine needs from the journey runner to run actor and parallel steps. */
export interface ActorRuntime {
  /** The actor steps outside any As block run as. */
  readonly primary: string;
  /** True when steps and evidence are labelled with their actor. */
  readonly labelled: boolean;
  /** Run parallel branches one after the other (the debugger and the time-travel trace follow one page). */
  readonly sequentialParallel: boolean;
  /** The live actor, creating its context the first time (`created` is then true). */
  enter(name: string): Promise<{ slot: ActorSlot; created: boolean }>;
  /** An actor that is already live. */
  get(name: string): ActorSlot | undefined;
  /**
   * Run the steps of a native (android / ios) actor's block on its platform driver: one driver attempt
   * per block, the journey's ledger handed over as variables and the block's ledger merged back.
   */
  runNative?(slot: ActorSlot, steps: Step[], ledgerView: Record<string, unknown>): Promise<{ steps: import('../core/index.js').StepResult[]; ledger: Record<string, unknown>; evidence: string[]; error?: string }>;
}
