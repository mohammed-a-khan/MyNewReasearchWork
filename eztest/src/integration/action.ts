/** The runner's entry point for `integration` steps. */
import { EzTestError, type Step } from '../core/index.js';
import type { ActionOutcome } from '../runner/actions.js';
import type { RunOptions, StepContext } from '../runner/types.js';

export async function integrationAction(step: Step, ctx: StepContext, opts: RunOptions, timeout: number): Promise<ActionOutcome> {
  if (!opts.integration) {
    throw new EzTestError(
      `"${step.intent}" needs the integration runtime: run through the EZTest engine (eztest run) with messaging/grpc/files/batch/contracts config, or pass RunOptions.integration = createIntegrationRuntime(...)`,
      'NO_HANDLER',
    );
  }
  return opts.integration.perform(step, ctx, timeout);
}
