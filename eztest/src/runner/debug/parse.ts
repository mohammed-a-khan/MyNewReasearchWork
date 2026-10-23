/** Parse edited `.ez` text (one step line, optionally followed by Expect lines) into a Step. */
import { EzTestError, type Step } from '../../core/index.js';
import { parseEzScript } from '../../intent/ezscript.js';

export function parseStepText(text: string): Step {
  const body = text.replace(/\r\n/g, '\n').trim();
  if (!body) throw new EzTestError('Empty step text', 'BAD_STEP');
  const lines = body.split('\n');
  if (/^\s*(journey|name|id|tags|role)\s*:/i.test(lines[0])) throw new EzTestError('Expected a step line, not a journey header', 'BAD_STEP');
  let journey;
  try {
    journey = parseEzScript(`Journey: debugger edit\n${body}`);
  } catch (e) {
    throw new EzTestError((e as Error).message.replace(/line (\d+)/, (_m, n: string) => `line ${Number(n) - 1}`), 'BAD_STEP');
  }
  if (journey.steps.length !== 1) throw new EzTestError(`Expected exactly one step, got ${journey.steps.length}`, 'BAD_STEP');
  return journey.steps[0];
}
