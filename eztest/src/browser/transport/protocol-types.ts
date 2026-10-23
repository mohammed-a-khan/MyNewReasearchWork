/**
 * Result types for the protocol commands whose results callers read field
 * by field (written from the public CDP documentation). Every other command
 * returns a loosely typed record.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface WebAuthnCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
  largeBlob?: string;
}

export interface KnownCommands {
  'WebAuthn.enable': { params: { enableUI?: boolean }; result: Record<string, never> };
  'WebAuthn.addVirtualAuthenticator': {
    params: {
      options: {
        protocol: 'ctap2' | 'u2f';
        ctap2Version?: 'ctap2_0' | 'ctap2_1';
        transport: 'usb' | 'nfc' | 'ble' | 'cable' | 'internal';
        hasResidentKey?: boolean;
        hasUserVerification?: boolean;
        hasLargeBlob?: boolean;
        hasCredBlob?: boolean;
        hasMinPinLength?: boolean;
        hasPrf?: boolean;
        automaticPresenceSimulation?: boolean;
        isUserVerified?: boolean;
      };
    };
    result: { authenticatorId: string };
  };
  'WebAuthn.getCredentials': { params: { authenticatorId: string }; result: { credentials: WebAuthnCredential[] } };
  'WebAuthn.addCredential': { params: { authenticatorId: string; credential: WebAuthnCredential }; result: Record<string, never> };
  'WebAuthn.clearCredentials': { params: { authenticatorId: string }; result: Record<string, never> };
  'WebAuthn.setUserVerified': { params: { authenticatorId: string; isUserVerified: boolean }; result: Record<string, never> };
  'WebAuthn.removeVirtualAuthenticator': { params: { authenticatorId: string }; result: Record<string, never> };
  'Target.attachToTarget': { params: { targetId: string; flatten?: boolean }; result: { sessionId: string } };
  'Target.getTargets': { params: Record<string, any>; result: { targetInfos: Array<{ targetId: string; type: string; title: string; url: string; attached: boolean; openerId?: string; browserContextId?: string }> } };
}
