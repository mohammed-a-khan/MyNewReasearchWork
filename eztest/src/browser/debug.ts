/**
 * Debug logging for the browser driver, enabled with the EZTEST_DEBUG
 * environment variable (comma-separated topics, or `*`):
 *
 *   EZTEST_DEBUG=protocol   every protocol message (sent ▶ / received ◀)
 *   EZTEST_DEBUG=browser    launch command lines, process exit, targets
 *   EZTEST_DEBUG=*          everything
 *
 * Output goes to stderr. Long messages are truncated to EZTEST_DEBUG_MAX
 * characters (default 2000; 0 = never truncate).
 */
export type DebugTopic = 'protocol' | 'browser' | 'network' | 'input';

function enabledTopics(): Set<string> {
  return new Set((process.env.EZTEST_DEBUG ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

export function debugEnabled(topic: DebugTopic): boolean {
  const t = enabledTopics();
  return t.has('*') || t.has(topic);
}

export function debugLog(topic: DebugTopic, message: string): void {
  if (!debugEnabled(topic)) return;
  const max = Number(process.env.EZTEST_DEBUG_MAX ?? 2000);
  const text = max > 0 && message.length > max ? `${message.slice(0, max)}… (${message.length} chars)` : message;
  process.stderr.write(`[eztest:${topic}] ${new Date().toISOString().slice(11, 23)} ${text}\n`);
}
