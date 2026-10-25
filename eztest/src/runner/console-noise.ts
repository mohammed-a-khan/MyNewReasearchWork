/**
 * Browser console noise (config `console.ignore`): messages that match one of the configured regular
 * expressions (a third-party widget's warning, a known deprecation) are marked `ignored`. "No console
 * errors" checks and failure diagnostics leave them out; reports count them as "n ignored".
 */

/** A matcher for the configured patterns (case-insensitive); undefined when there are none. */
export function consoleNoise(patterns: string[] | undefined): ((text: string) => boolean) | undefined {
  if (!patterns?.length) return undefined;
  const res = patterns.map((p) => {
    const m = /^\/(.+)\/([a-z]*)$/.exec(p);
    return m ? new RegExp(m[1], m[2].includes('i') ? m[2] : `${m[2]}i`) : new RegExp(p, 'i');
  });
  return (text) => res.some((r) => r.test(text));
}
