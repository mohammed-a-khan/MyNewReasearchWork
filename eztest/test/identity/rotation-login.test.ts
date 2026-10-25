/**
 * Password rotation with `overlapDays`: the passwords around a rotation boundary are tried in order, the one
 * that worked is cached (encrypted) per role next to the sessions and tried first next time, a cached password
 * that is no longer accepted is dropped, and every attempt counts toward the lockout guard. Real Chromium
 * against the clinic app's sign-in form.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '../../src/browser/index.js';
import { SecretMasker } from '../../src/config/index.js';
import {
  IdentityVault, LockoutGuard, MemorySecretStore, SecretRegistry, createPasswordRotationProvider, createPooledLogin, formatPeriod, overlapPeriods, rotationPeriod,
} from '../../src/identity/index.js';
import { startClinicApp, type ClinicApp } from '../support/clinic.js';

let app: ClinicApp;
let browser: Browser;
let dir: string;
beforeAll(async () => {
  app = await startClinicApp({ desk: 'unused' });
  browser = await chromium.launch();
  dir = mkdtempSync(join(tmpdir(), 'eztest-rotation-'));
});
afterAll(async () => {
  await browser?.close();
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

const now = new Date();
const today = now.getUTCDate();
// The clinic's desk password rotates on today's day of the month: we are on the boundary.
const config = { type: 'monthly-formula', prefix: 'secret://vault/pre', format: 'YYYYMM', rotatesOn: today, overlapDays: 2 };
const current = rotationPeriod(now, today);
const previous = current.month === 1 ? { year: current.year - 1, month: 12 } : { year: current.year, month: current.month - 1 };
const pw = (p: { year: number; month: number }) => `Desk!${formatPeriod(p, 'YYYYMM')}`;

function login(guardFile: string, maxFailures: number) {
  const masker = new SecretMasker();
  const registry = new SecretRegistry([new MemorySecretStore({ pre: 'Desk!' }, 'vault')], masker);
  const provider = createPasswordRotationProvider(config, { registry, role: 'receptionist' });
  const vault = new IdentityVault({
    baseUrl: app.url, environment: 'test', sessionDir: join(dir, 'sessions'), registry, sessionMaxAgeMs: 1,
    roles: { receptionist: { username: 'desk', password: 'secret://vault/pre', passwordCandidates: () => provider.candidates!(), loginUrl: '/login', successUrl: '/home' } },
  });
  const guard = new LockoutGuard(guardFile, { maxFailures, backoffMs: 0 });
  return { vault, masker, pooled: createPooledLogin({ vault, guard, maxAgeMs: 1, refreshMarginMs: 0 }) };
}

async function signIn(l: ReturnType<typeof login>): Promise<string> {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await l.pooled.login(page, 'receptionist', { journey: { id: 'rotation' }, runId: 'r1', attempt: 1 });
    return (await page.textContent('h1')) ?? '';
  } finally {
    await ctx.close();
  }
}

describe('password rotation with an overlap (real Chromium)', () => {
  it('orders the candidates around the boundary', () => {
    expect(overlapPeriods(new Date('2026-11-06T09:00:00Z'), 'first-friday', 2)).toEqual([{ year: 2026, month: 11 }, { year: 2026, month: 10 }]);
    expect(overlapPeriods(new Date('2026-11-05T09:00:00Z'), 'first-friday', 2)).toEqual([{ year: 2026, month: 10 }, { year: 2026, month: 11 }]);
    expect(overlapPeriods(new Date('2026-11-20T09:00:00Z'), 'first-friday', 2)).toEqual([{ year: 2026, month: 11 }]);
    expect(overlapPeriods(new Date('2026-11-06T09:00:00Z'), 'first-friday', 0)).toEqual([{ year: 2026, month: 11 }]);
  });

  it('tries the passwords in order, caches the one that worked (encrypted), drops it when it stops working, and counts every attempt', async () => {
    // The account still has last period's password: the current one is refused, the previous one works.
    app.users.desk = pw(previous);
    const first = login(join(dir, 'lockout-a.json'), 3);
    expect(await signIn(first)).toBe('Signed in as desk');
    expect(app.attempts.desk).toBe(2);
    const cache = first.vault.lastKnownGoodFile('receptionist');
    expect(existsSync(cache)).toBe(true);
    const text = readFileSync(cache, 'utf8');
    expect(text.startsWith('ENC(')).toBe(true);
    expect(text).not.toContain(pw(previous));
    expect(first.masker.mask(`typed ${pw(previous)}`)).not.toContain(pw(previous));

    // Next time the cached password is tried first: one attempt.
    app.attempts.desk = 0;
    expect(await signIn(login(join(dir, 'lockout-a.json'), 3))).toBe('Signed in as desk');
    expect(app.attempts.desk).toBe(1);

    // The rotation happened: the cached password is refused and dropped, the current one works and is cached.
    app.users.desk = pw(current);
    app.attempts.desk = 0;
    const later = login(join(dir, 'lockout-a.json'), 3);
    expect(await signIn(later)).toBe('Signed in as desk');
    expect(app.attempts.desk).toBe(2);
    app.attempts.desk = 0;
    expect(await signIn(login(join(dir, 'lockout-a.json'), 3))).toBe('Signed in as desk');
    expect(app.attempts.desk).toBe(1);

    // Every attempt counts toward identity.lockout: with maxFailures 1, the refused first password blocks the second.
    app.users.desk = pw(previous);
    app.attempts.desk = 0;
    await later.vault.clearLastKnownGood('receptionist');
    const strict = login(join(dir, 'lockout-b.json'), 1);
    await expect(signIn(strict)).rejects.toThrow(/stopped trying so the account is not locked/);
    expect(app.attempts.desk).toBe(1);
    const recorded = JSON.parse(readFileSync(join(dir, 'lockout-b.json'), 'utf8')) as { accounts: Record<string, { failures: number[] }> };
    expect(Object.values(recorded.accounts)[0].failures.length).toBe(1);
  });
});
