/**
 * Which consent document set applies to a user: adult or U18.
 *
 * Both the consent status read and the acceptance write derive the variant
 * here, so the terms shown always match the version recorded. The variant is
 * server-side only: a client that chose it would choose which terms bind it.
 *
 * @module apps/api/services/consent_variant
 */
import type { DbOrTx } from '@/services/item_service';
import { getWardAge } from '@/services/minor_guardian_repo';
import { isMinor } from '@/services/minor';

/** Which document set a user's consent applies to. */
export type ConsentVariant = 'adult' | 'u18';

/**
 * Resolves the consent variant from the user's recorded age: `'u18'` for a
 * known minor, `'adult'` otherwise, including when no age was captured.
 */
export async function resolveUserConsentVariant(
  userId: string,
  exec?: DbOrTx,
): Promise<ConsentVariant> {
  const age = exec ? await getWardAge(userId, exec) : await getWardAge(userId);
  return age !== null && isMinor(age) ? 'u18' : 'adult';
}
