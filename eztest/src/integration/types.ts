/** The integration runtime contract the runner uses for `integration` steps. */
import type { Step } from '../core/index.js';
import type { StepContext } from '../runner/types.js';

export interface IntegrationOutcome {
  captured?: Record<string, unknown>;
  evidence?: string[];
}

export interface IntegrationRuntime {
  /** Perform one integration step (args.kind: bus | grpc | file | ssh | batch | edi | contract). */
  perform(step: Step, ctx: StepContext, timeoutMs: number): Promise<IntegrationOutcome>;
  /** Close broker connections, subscriptions and SSH/SFTP sessions. */
  close(): Promise<void>;
}
