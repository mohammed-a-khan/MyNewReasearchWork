import { describe, expect, it } from '../support/testkit.js';
import { SecretMasker } from '../../src/config/index.js';
import {
  createPasswordRotationProvider, formatPeriod, MemorySecretStore, passwordRotationTypes, registerPasswordRotationProvider, rotationDay, rotationPeriod, SecretRegistry,
} from '../../src/identity/index.js';

describe('password rotation providers', () => {
  it('computes rotation days and the period valid at a date', () => {
    expect(rotationDay(2026, 10, 'first-friday')).toBe(2);
    expect(rotationDay(2026, 11, 'first-friday')).toBe(6);
    expect(rotationDay(2026, 10, 'last-monday')).toBe(26);
    expect(rotationDay(2026, 10, 'second-tuesday')).toBe(13);
    expect(rotationDay(2026, 10, 15)).toBe(15);
    expect(() => rotationDay(2026, 10, 'every-full-moon')).toThrow(/not understood/);
    // Before the first Friday of November, October's password is still valid.
    expect(rotationPeriod(new Date('2026-11-05T12:00:00Z'), 'first-friday')).toEqual({ year: 2026, month: 10 });
    expect(rotationPeriod(new Date('2026-11-06T00:00:00Z'), 'first-friday')).toEqual({ year: 2026, month: 11 });
    expect(rotationPeriod(new Date('2026-01-01T12:00:00Z'), 'first-friday')).toEqual({ year: 2025, month: 12 }); // Thursday before the first Friday
    expect(rotationPeriod(new Date('2027-01-01T12:00:00Z'), 'first-friday')).toEqual({ year: 2027, month: 1 }); // a Friday itself
    // Time zones move the day boundary.
    expect(rotationPeriod(new Date('2026-11-06T02:00:00Z'), 'first-friday', 'America/New_York')).toEqual({ year: 2026, month: 10 });
    expect(formatPeriod({ year: 2026, month: 3 }, 'MMMYYYY-MM-M-YY-MMMM')).toBe('Mar2026-03-3-26-March');
  });

  it('builds the monthly-formula password from secret parts, masks it, and accepts custom providers', async () => {
    const masker = new SecretMasker();
    const registry = new SecretRegistry([new MemorySecretStore({ pre: 'Qa!', suf: '#x' }, 'mem')], masker);
    const p = createPasswordRotationProvider({ type: 'monthly-formula', prefix: 'secret://mem/pre', suffix: 'secret://mem/suf', format: 'YYYYMM', rotatesOn: 'first-friday' }, { registry, role: 'qa' });
    expect(await p.current(new Date('2026-11-05T12:00:00Z'))).toBe('Qa!202610#x');
    expect(await p.current(new Date('2026-11-09T12:00:00Z'))).toBe('Qa!202611#x');
    expect(p.describe()).toBe('monthly formula: prefix + YYYYMM + suffix, rotates on first-friday');
    expect(p.describe()).not.toContain('Qa!');
    expect(() => createPasswordRotationProvider({ type: 'nope' }, { registry, role: 'qa' })).toThrow(/unknown passwordRotation type "nope"/);
    registerPasswordRotationProvider('test-fixed', () => ({ type: 'test-fixed', current: async () => 'fixed-pw', describe: () => 'fixed' }));
    expect(passwordRotationTypes()).toContain('test-fixed');
    expect(await createPasswordRotationProvider({ type: 'test-fixed' }, { registry, role: 'qa' }).current()).toBe('fixed-pw');
    expect(() => registerPasswordRotationProvider('Bad Name', () => p)).toThrow(/Invalid/);
  });
});
