/**
 * Load profiles as piecewise-linear curves of a target over time: virtual
 * users (closed model) or iterations per second (open model). Every profile
 * type (constant, ramp, step, peak/spike, soak, custom) becomes a list of
 * points, so evaluation, previews and the distributed split are one code path.
 */
import { EzTestError } from '../core/index.js';
import { ProfileSpec, type ProfileInput } from './model.js';

export interface CurvePoint {
  /** ms from the start. */
  at: number;
  value: number;
}

export class LoadCurve {
  constructor(readonly points: CurvePoint[]) {
    if (points.length < 1) throw new EzTestError('a load curve needs at least one point', 'LOAD_SCENARIO');
    for (let i = 1; i < points.length; i++) {
      if (points[i].at < points[i - 1].at) throw new EzTestError('load curve points must be in time order', 'LOAD_SCENARIO');
    }
  }

  get durationMs(): number {
    return this.points[this.points.length - 1].at;
  }

  get peak(): number {
    return Math.max(...this.points.map((p) => p.value));
  }

  /** Target at time t (linear interpolation; vertical jumps take the later value). */
  at(t: number): number {
    const p = this.points;
    if (t <= p[0].at) return p[0].value;
    if (t >= p[p.length - 1].at) return p[p.length - 1].value;
    let lo = 0;
    let hi = p.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (p[mid].at <= t) lo = mid;
      else hi = mid;
    }
    // Several points at the same time: the last of them wins.
    while (lo + 1 < p.length && p[lo + 1].at === t) lo++;
    const a = p[lo];
    const b = p[Math.min(lo + 1, p.length - 1)];
    if (b.at === a.at) return b.value;
    return a.value + ((b.value - a.value) * (t - a.at)) / (b.at - a.at);
  }

  /** Integral of the curve from 0 to t (expected iterations for a rate curve, VU-ms for a VU curve). */
  integral(t: number): number {
    const p = this.points;
    let acc = 0;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1];
      const b = p[i];
      if (a.at >= t) break;
      const end = Math.min(b.at, t);
      if (end <= a.at) continue;
      const vEnd = a.value + ((b.value - a.value) * (end - a.at)) / (b.at - a.at || 1);
      acc += ((a.value + vEnd) / 2) * (end - a.at);
    }
    return acc;
  }

  /** The same curve scaled (e.g. a population's share or an agent's slice). */
  scale(f: number): LoadCurve {
    return new LoadCurve(this.points.map((p) => ({ at: p.at, value: p.value * f })));
  }

  /** Samples for previews: `n` evenly spaced points plus every corner. */
  sample(n = 100): CurvePoint[] {
    const d = this.durationMs;
    const set = new Map<number, number>();
    for (let i = 0; i <= n; i++) {
      const t = Math.round((d * i) / n);
      set.set(t, this.at(t));
    }
    for (const p of this.points) set.set(p.at, p.value);
    return [...set.entries()].sort((a, b) => a[0] - b[0]).map(([at, value]) => ({ at, value }));
  }
}

const target = (spec: { vus?: number; rate?: number }, model: 'closed' | 'open', what: string): number => {
  const v = model === 'open' ? (spec.rate ?? spec.vus) : (spec.vus ?? spec.rate);
  if (v === undefined) throw new EzTestError(`${what} profile needs ${model === 'open' ? 'rate (iterations per second)' : 'vus'}`, 'LOAD_SCENARIO');
  return v;
};

/** Build the curve for a profile in a model (closed = VUs, open = iterations/second). */
export function profileCurve(input: ProfileSpec | ProfileInput, model: 'closed' | 'open' = 'closed'): LoadCurve {
  const r = ProfileSpec.safeParse(input);
  if (!r.success) throw new EzTestError(`Invalid load profile: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'LOAD_SCENARIO');
  const p = r.data;
  switch (p.type) {
    case 'constant': {
      const v = target(p, model, 'constant');
      return new LoadCurve([{ at: 0, value: v }, { at: p.duration, value: v }]);
    }
    case 'ramp': {
      const v = target(p, model, 'ramp');
      const pts: CurvePoint[] = [{ at: 0, value: p.from }, { at: p.rampUp, value: v }];
      if (p.plateau) pts.push({ at: p.rampUp + p.plateau, value: v });
      if (p.rampDown) pts.push({ at: p.rampUp + p.plateau + p.rampDown, value: 0 });
      return new LoadCurve(pts);
    }
    case 'step': {
      if (p.step <= 0) throw new EzTestError('step profile: step must be > 0', 'LOAD_SCENARIO');
      if (p.every <= 0) throw new EzTestError('step profile: every must be > 0', 'LOAD_SCENARIO');
      const pts: CurvePoint[] = [{ at: 0, value: p.from }];
      let v = p.from;
      let t = 0;
      const ramp = Math.min(p.rampWithin, p.every);
      while (v < p.to) {
        t += p.every;
        const next = Math.min(p.to, v + p.step);
        pts.push({ at: t, value: v });
        pts.push({ at: t + ramp, value: next });
        v = next;
      }
      pts.push({ at: t + ramp + Math.max(p.hold, p.every), value: v });
      return new LoadCurve(dedupe(pts));
    }
    case 'peak': {
      if (p.peakEvery <= 0 || p.peakFor <= 0 || p.peakFor >= p.peakEvery) throw new EzTestError('peak profile: 0 < peakFor < peakEvery', 'LOAD_SCENARIO');
      const pts: CurvePoint[] = [{ at: 0, value: p.base }];
      const ramp = Math.min(p.rampWithin, p.peakFor / 2);
      for (let start = p.peakEvery - p.peakFor; start < p.duration; start += p.peakEvery) {
        const end = Math.min(p.duration, start + p.peakFor);
        pts.push({ at: start, value: p.base }, { at: start + ramp, value: p.peak }, { at: Math.max(start + ramp, end - ramp), value: p.peak }, { at: end, value: p.base });
      }
      pts.push({ at: p.duration, value: p.base });
      return new LoadCurve(dedupe(pts));
    }
    case 'soak': {
      const v = target(p, model, 'soak');
      const pts: CurvePoint[] = [{ at: 0, value: 0 }, { at: p.rampUp, value: v }, { at: p.duration - p.rampDown, value: v }];
      if (p.rampDown) pts.push({ at: p.duration, value: 0 });
      if (p.duration <= p.rampUp + p.rampDown) throw new EzTestError('soak profile: duration must exceed rampUp + rampDown', 'LOAD_SCENARIO');
      return new LoadCurve(pts);
    }
    case 'custom':
      return new LoadCurve([...p.points].sort((a, b) => a.at - b.at));
  }
}

function dedupe(pts: CurvePoint[]): CurvePoint[] {
  const out: CurvePoint[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.at === p.at && last.value === p.value) continue;
    out.push(p);
  }
  return out;
}

/** Split an integer total over weights so the parts add up exactly (largest remainder). */
export function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let rest = Math.round(total - out.reduce((a, b) => a + b, 0));
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) out[order[k][1]]++;
  return out;
}
