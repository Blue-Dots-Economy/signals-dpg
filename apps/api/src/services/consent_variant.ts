/**
 * Which consent document set applies to a user — the adult set or the U18 set.
 *
 * The login consent gate used to read `documents` unconditionally, so a known
 * minor was shown the adult terms AND had the acceptance recorded against the
 * adult `document_version` (#626). Both the status read and the acceptance
 * write now derive the variant here, from one definition: if the two paths
 * answered this question separately they could disagree, and the whole bug
 * class is a display that says one thing while the ledger records another.
 *
 * **Server-side only, never client-supplied.** A client that could choose its
 * own variant could choose which terms it is bound by — the same reasoning
 * that keeps version integers out of request bodies (see `consent_version`).
 *
 * Belongs to `@dpg/api`.
 *
 * @module apps/api/services/consent_variant
 */
import type { DbOrTx } from '@/services/item_service';
import { getWardAge } from '@/services/minor_guardian_repo';
import { isMinor } from '@/services/minor';

/** Which document set a user's consent applies to. */
export type ConsentVariant = 'adult' | 'u18';

/**
 * Resolves the consent variant for a user from their recorded age.
 *
 * Mirrors what `get_profile_consent_status` already does for the guardian
 * gate, so the login gate and the profile gate agree about who is a minor.
 *
 * Returns `'adult'` when the age is unknown, which is most users: `user.age`
 * is only populated on the U18/guardian paths. That is the safe default —
 * this protects minors the platform already knows about, and never blocks a
 * user whose age was never captured.
 *
 * @param userId - The authenticated user's id.
 * @param exec - Transaction handle; defaults to the shared connection.
 * @returns `'u18'` for a known minor, `'adult'` otherwise.
 */
export async function resolveUserConsentVariant(
  userId: string,
  exec?: DbOrTx,
): Promise<ConsentVariant> {
  const age = exec ? await getWardAge(userId, exec) : await getWardAge(userId);
  return age !== null && isMinor(age) ? 'u18' : 'adult';
}
