/**
 * The login-time terms/privacy gate, shared by every caller (OTP login,
 * Keycloak panel, OIDC callback, `use-consent-gate`) so the U18 document
 * variant is applied consistently.
 *
 * @module lib/consent-gate
 */
import type { ConsentAcceptBody, ConsentConfigDocument } from '@dpg/schemas';

/** Which document set a user's consent applies to. Mirrors the API's type. */
export type ConsentVariant = 'adult' | 'u18';

/** The two documents the login gate cares about. */
export type GateCategory = 'terms' | 'privacy';

export const GATE_CATEGORIES = ['terms', 'privacy'] as const satisfies readonly GateCategory[];

/**
 * The terms/privacy pair that applies to `variant`. Falls back to the adult set
 * when the brand ships no `u18_documents`: most networks configure none, and
 * gating a minor against documents that do not exist would lock them out.
 */
export function consentDocumentSet(
  config: ConsentConfigDocument,
  variant: ConsentVariant,
): { terms: ConsentConfigDocument['documents']['terms']; privacy: ConsentConfigDocument['documents']['privacy'] } {
  const u18 = config.u18_documents;
  if (variant === 'u18' && u18) return { terms: u18.terms, privacy: u18.privacy };
  return { terms: config.documents.terms, privacy: config.documents.privacy };
}

/** The version of each gate document currently in force for `variant`. */
export function currentGateVersions(
  config: ConsentConfigDocument,
  variant: ConsentVariant,
): Record<GateCategory, number> {
  const docs = consentDocumentSet(config, variant);
  return { terms: docs.terms.current_version, privacy: docs.privacy.current_version };
}

/**
 * Which gate documents this user still owes, compared against `variant`'s
 * versions so a minor who accepted the U18 terms is not re-prompted with the adult ones.
 */
export function outstandingGateCategories(
  config: ConsentConfigDocument,
  variant: ConsentVariant,
  accepted: Record<GateCategory, number[]>,
): GateCategory[] {
  const versions = currentGateVersions(config, variant);
  return GATE_CATEGORIES.filter((c) => !accepted[c].includes(versions[c]));
}

/** What the caller needs to render the modal and record the acceptance. */
export interface OutstandingConsent {
  config: ConsentConfigDocument;
  /** Passed to `<ConsentModal variant>` so the copy matches what gets recorded. */
  variant: ConsentVariant;
  pendingConsent: ConsentAcceptBody;
}

/**
 * Builds the gate state from an already-fetched status and merged config, or
 * returns null when nothing is outstanding. Synchronous and side-effect free:
 * each caller fetches and handles errors its own way.
 */
export function buildOutstandingConsent(args: {
  config: ConsentConfigDocument;
  network: string;
  /** Raw theme brand; `'standard'` means "no brand" and is stored as null. */
  brand: string | null;
  source: ConsentAcceptBody['source'];
  accepted: Record<GateCategory, number[]>;
  /** From the status endpoint, which derives it server-side. Never client-chosen. */
  variant?: ConsentVariant;
}): OutstandingConsent | null {
  const variant: ConsentVariant = args.variant ?? 'adult';
  const needed = outstandingGateCategories(args.config, variant, args.accepted);
  if (needed.length === 0) return null;

  const versions = currentGateVersions(args.config, variant);
  return {
    config: args.config,
    variant,
    pendingConsent: {
      network: args.network,
      brand: args.brand && args.brand !== 'standard' ? args.brand : null,
      source: args.source,
      items: needed.map((c) => ({ category: c, version: versions[c] })),
    },
  };
}
