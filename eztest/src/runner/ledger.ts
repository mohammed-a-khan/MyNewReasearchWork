/** The per-journey ledger: captured values, API responses, DB rows and downloads. */
export class Ledger {
  private readonly values: Record<string, unknown> = {};

  set(key: string, value: unknown): void {
    if (!key) throw new Error('Ledger key must not be empty');
    this.values[key] = value;
  }

  get(key: string): unknown {
    let cur: unknown = this.values;
    for (const part of key.split('.')) {
      if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
      else return undefined;
    }
    return cur;
  }

  /** Remove a top-level key (loop variables are unbound after the loop). */
  delete(key: string): void {
    delete this.values[key];
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** A JSON-safe copy for results. */
  toJSON(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this.values)) as Record<string, unknown>;
  }

  /** Live view used for interpolation. */
  view(): Readonly<Record<string, unknown>> {
    return this.values;
  }
}

/** Downloaded file as recorded in the ledger. */
export interface DownloadRecord {
  path: string;
  relPath: string;
  filename: string;
  evidenceId: string;
  sha256: string;
  size: number;
}
