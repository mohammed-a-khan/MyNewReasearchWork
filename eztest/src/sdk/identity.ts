/**
 * `identity`: sign in as an Identity Vault role (verified session reuse, MFA
 * handled by the vault) and one-time codes.
 */
import { generateTotp } from '../identity/totp.js';
import { ui, type ActionOptions } from './ui.js';

export const identity = {
  /** Sign the browser in as a role from `identity.roles` (default: the journey's role). */
  loginAs(role?: string, o: ActionOptions = {}): Promise<void> {
    return ui.login(role, o);
  },
  /** The current TOTP code for a base32 secret (e.g. from a secret variable). */
  totp(secretBase32: string, o: { digits?: number; period?: number } = {}): string {
    return generateTotp(secretBase32, { ...(o.digits ? { digits: o.digits } : {}), ...(o.period ? { step: o.period } : {}) });
  },
};

export type IdentitySurface = typeof identity;
