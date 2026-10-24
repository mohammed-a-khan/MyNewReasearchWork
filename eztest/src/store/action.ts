/** The runner's entry point for `store` steps (shared store and data pools). */
import { EzTestError, type Step } from '../core/index.js';
import type { ActionOutcome } from '../runner/actions.js';
import type { RunOptions, StepContext } from '../runner/types.js';

export async function storeAction(step: Step, ctx: StepContext, opts: RunOptions): Promise<ActionOutcome> {
  if (!opts.store) {
    throw new EzTestError(
      `"${step.intent}" needs the shared store: run through the EZTest engine (eztest run), or pass RunOptions.store = new SharedStore({ backend: new FileStoreBackend('.eztest/store') })`,
      'NO_HANDLER',
    );
  }
  return opts.store.perform(step, ctx);
}
