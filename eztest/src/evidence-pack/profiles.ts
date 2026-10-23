/**
 * Regulatory profiles add context to a pack: what the signature means, which
 * fields an auditor expects, and warnings for gaps (e.g. untraced journeys).
 * They describe evidence; they do not certify compliance.
 */
import { NotSupportedError } from '../core/index.js';

export type RegulatoryProfileId = 'generic' | 'csa-part11' | 'sox';

export interface ProfileInfo {
  id: RegulatoryProfileId;
  title: string;
  /** Statements included verbatim in the manifest and summary. */
  statements: string[];
  /** Meaning of the signature (21 CFR 11.50(a)(3) style). */
  signatureMeaning: string;
  /** Whether every journey must trace to a requirement / control id. */
  requireTraceability: boolean;
  /** Label for requirement ids in the traceability table. */
  requirementLabel: string;
}

export const PROFILES: Record<RegulatoryProfileId, ProfileInfo> = {
  generic: {
    id: 'generic',
    title: 'Generic test evidence pack',
    statements: [
      'This pack contains the run result, the hash-chained evidence manifest and the evidence files of one EZTest run.',
    ],
    signatureMeaning: 'Packaged and attested as an unaltered copy of the run evidence',
    requireTraceability: false,
    requirementLabel: 'Requirement',
  },
  'csa-part11': {
    id: 'csa-part11',
    title: 'Computer Software Assurance evidence (21 CFR Part 11 oriented)',
    statements: [
      'Record integrity: every evidence file is listed with its SHA-256 and linked in an append-only hash chain (audit trail of the run).',
      'Signature manifestation: the signer printed name, role, date/time (UTC) and meaning of the signature are recorded in the signed manifest.',
      'Signature/record linking: the ed25519 signature covers the canonical manifest, which binds every file hash, so the signature cannot be transferred to another record.',
      'Assurance activity: the journeys executed, their results and the requirements they verify are listed in the traceability table.',
      'This pack supports, but does not by itself establish, Part 11 compliance; procedural controls (identity verification, key custody, training) remain the organization\'s responsibility.',
    ],
    signatureMeaning: 'Reviewed and approved as objective evidence of the assurance activity',
    requireTraceability: true,
    requirementLabel: 'Requirement / URS id',
  },
  sox: {
    id: 'sox',
    title: 'SOX IT general control test evidence',
    statements: [
      'Control testing evidence: each journey is an automated test of the control ids it lists; results and evidence are included unaltered.',
      'Completeness and accuracy: the hash chain and per-file SHA-256 values let an auditor re-perform integrity checks independently.',
      'Segregation of duties: the signer role is recorded; the signer should not be the author of the system change under test.',
      'This pack is supporting documentation; control design and operating effectiveness conclusions remain with management and the auditor.',
    ],
    signatureMeaning: 'Attested as complete and accurate evidence of the control test performed',
    requireTraceability: true,
    requirementLabel: 'Control id',
  },
};

export function profileInfo(id: RegulatoryProfileId | undefined): ProfileInfo {
  const p = PROFILES[id ?? 'generic'];
  if (!p) throw new NotSupportedError(`regulatory profile "${String(id)}" (available: ${Object.keys(PROFILES).join(', ')})`);
  return p;
}
