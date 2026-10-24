/**
 * Things registered in this process by code (a custom component adapter, a platform driver) that a
 * worker process would not have: a library run with any of them stays inline unless its
 * `workerSetup` registers them in the worker too.
 */
const active = new Map<string, number>();

/** Note a registration; returns the function that takes it back. */
export function noteLocalRegistration(kind: string): () => void {
  active.set(kind, (active.get(kind) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (active.get(kind) ?? 1) - 1;
    if (n > 0) active.set(kind, n);
    else active.delete(kind);
  };
}

/** Kinds registered in this process right now. */
export function localRegistrations(): string[] {
  return [...active.keys()];
}
