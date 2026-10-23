import { describe, it, expect } from '../support/testkit.js';
import { generateTotp, generateHotp, verifyTotp, base32Encode, base32Decode, totpSecondsRemaining } from '../../src/identity/index.js';
import { DEMO_TOTP_SECRET } from '../../examples/demo-app/server.js';

// RFC 6238 Appendix B
const SEEDS = {
  sha1: base32Encode('12345678901234567890'),
  sha256: base32Encode('12345678901234567890123456789012'),
  sha512: base32Encode('1234567890123456789012345678901234567890123456789012345678901234'),
} as const;
const VECTORS: Array<[number, string, string, string]> = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(VECTORS)('t=%i', (t, sha1, sha256, sha512) => {
    expect(generateTotp(SEEDS.sha1, { time: t * 1000, digits: 8, algorithm: 'sha1' })).toBe(sha1);
    expect(generateTotp(SEEDS.sha256, { time: t * 1000, digits: 8, algorithm: 'sha256' })).toBe(sha256);
    expect(generateTotp(SEEDS.sha512, { time: t * 1000, digits: 8, algorithm: 'sha512' })).toBe(sha512);
  });

  it('matches RFC 4226 HOTP vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, i) => expect(generateHotp(Buffer.from('12345678901234567890'), i)).toBe(code));
  });

  it('round-trips base32 and rejects bad input', () => {
    expect(base32Decode(base32Encode('hello world')).toString()).toBe('hello world');
    expect(base32Decode('jbsw y3dp')).toEqual(base32Decode('JBSWY3DP'));
    expect(() => base32Decode('!!!')).toThrow(/base32/);
    expect(() => base32Decode('')).toThrow(/empty/);
    expect(() => generateTotp(DEMO_TOTP_SECRET, { digits: 4 })).toThrow(/digits/);
  });

  it('verifies within the window only, rejecting malformed codes', () => {
    const t = 1_700_000_000_000;
    const code = generateTotp(DEMO_TOTP_SECRET, { time: t });
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(code, DEMO_TOTP_SECRET, { time: t })).toBe(true);
    expect(verifyTotp(code, DEMO_TOTP_SECRET, { time: t + 30_000 })).toBe(true);
    expect(verifyTotp(code, DEMO_TOTP_SECRET, { time: t + 90_000 })).toBe(false);
    expect(verifyTotp(code, DEMO_TOTP_SECRET, { time: t + 30_000, window: 0 })).toBe(false);
    expect(verifyTotp('', DEMO_TOTP_SECRET, { time: t })).toBe(false);
    expect(verifyTotp('12345a', DEMO_TOTP_SECRET, { time: t })).toBe(false);
    expect(totpSecondsRemaining({ time: 59_000 })).toBe(1);
  });
});
