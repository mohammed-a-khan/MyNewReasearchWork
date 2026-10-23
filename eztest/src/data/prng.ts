/** Seeded PRNG (mulberry32) with a string/number seed hashed by xmur3. Same seed => same sequence. */
export function hashSeed(seed: string | number): number {
  const s = String(seed);
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Prng {
  private readonly next: () => number;
  constructor(readonly seed: string | number) {
    this.next = mulberry32(hashSeed(seed));
  }
  /** [0, 1) */
  float(): number {
    return this.next();
  }
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) throw new RangeError(`int(${min}, ${max}): invalid range`);
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick() from an empty list');
    return items[Math.floor(this.next() * items.length)];
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.floor(this.next() * 256);
    return out;
  }
  /** A child generator with an independent, reproducible stream. */
  fork(label: string): Prng {
    return new Prng(`${this.seed}/${label}`);
  }
}
