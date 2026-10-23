/**
 * WebAuthn / passkeys: a CDP virtual authenticator on a Chromium page, so
 * passkey registration and sign-in can be tested without hardware.
 */
import type { CDPSession, Page } from '../browser/index.js';
import { EzTestError, NotSupportedError } from '../core/index.js';

export interface VirtualAuthenticatorOptions {
  protocol?: 'ctap2' | 'u2f';
  ctap2Version?: 'ctap2_0' | 'ctap2_1';
  transport?: 'internal' | 'usb' | 'nfc' | 'ble' | 'cable';
  hasResidentKey?: boolean;
  hasUserVerification?: boolean;
  isUserVerified?: boolean;
  automaticPresenceSimulation?: boolean;
}

export interface VirtualCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  userHandle?: string;
  signCount: number;
}

export class VirtualAuthenticator {
  constructor(
    readonly id: string,
    private readonly cdp: CDPSession,
  ) {}

  async getCredentials(): Promise<VirtualCredential[]> {
    const r = await this.cdp.send('WebAuthn.getCredentials', { authenticatorId: this.id });
    // Private keys stay inside the authenticator object; never return them.
    return r.credentials.map((c) => ({
      credentialId: c.credentialId,
      isResidentCredential: c.isResidentCredential,
      rpId: c.rpId,
      userHandle: c.userHandle,
      signCount: c.signCount,
    }));
  }

  async clearCredentials(): Promise<void> {
    await this.cdp.send('WebAuthn.clearCredentials', { authenticatorId: this.id });
  }

  async setUserVerified(isUserVerified: boolean): Promise<void> {
    await this.cdp.send('WebAuthn.setUserVerified', { authenticatorId: this.id, isUserVerified });
  }

  async remove(): Promise<void> {
    await this.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: this.id });
    await this.cdp.detach().catch(() => undefined);
  }
}

export async function addVirtualAuthenticator(page: Page, o: VirtualAuthenticatorOptions = {}): Promise<VirtualAuthenticator> {
  const browserName = page.context().browser()?.browserType().name();
  if (browserName && browserName !== 'chromium') {
    throw new NotSupportedError(`WebAuthn virtual authenticators on ${browserName} (Chromium only, via CDP)`);
  }
  let cdp: CDPSession;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch {
    throw new NotSupportedError('WebAuthn virtual authenticators without a Chromium DevTools session');
  }
  const protocol = o.protocol ?? 'ctap2';
  try {
    await cdp.send('WebAuthn.enable', { enableUI: false });
    const r = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol,
        ...(protocol === 'ctap2' ? { ctap2Version: o.ctap2Version ?? 'ctap2_1' } : {}),
        transport: o.transport ?? 'internal',
        hasResidentKey: o.hasResidentKey ?? true,
        hasUserVerification: o.hasUserVerification ?? true,
        isUserVerified: o.isUserVerified ?? true,
        automaticPresenceSimulation: o.automaticPresenceSimulation ?? true,
      },
    });
    return new VirtualAuthenticator(r.authenticatorId, cdp);
  } catch (e) {
    throw new EzTestError(`Could not add a virtual authenticator: ${(e as Error).message}`, 'WEBAUTHN');
  }
}
