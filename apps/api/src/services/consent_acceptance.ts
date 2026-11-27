import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import type { DbOrTx } from './item_service';

/**
 * True when the user has accepted both terms and privacy for the network at
 * user level, at any version (the ledger is append-only). This is the
 * prerequisite for recording `profile_creation` consent, which lets the live
 * gate check `hasAcceptedProfileConsent` alone.
 */
export async function hasAcceptedTermsAndPrivacy(
  exec: DbOrTx,
  userId: string,
  network: string,
): Promise<boolean> {
  const rows = await exec
    .select({ category: consent_record.consentCategory })
    .from(consent_record)
    .where(
      and(
        eq(consent_record.userId, userId),
        eq(consent_record.level, 'user'),
        eq(consent_record.network, network),
        inArray(consent_record.consentCategory, ['terms', 'privacy']),
      ),
    );
  const categories = new Set(rows.map((r) => r.category));
  return categories.has('terms') && categories.has('privacy');
}

/**
 * True when `profile_creation` consent exists for this item: the consent gate
 * for making a profile live. Because terms and privacy are required first, it
 * also implies user-level consent.
 *
 * Keyed on `itemId` alone, as `promoteItemOnProfileConsent` is: keying on the
 * item's `created_by` would miss consent recorded by another user (on-behalf
 * or bulk profiles) and demote the item on its next edit.
 *
 * Reads `consent_record`, not the `user.terms_accepted`/`privacy_accepted`
 * flags.
 */
export async function hasAcceptedProfileConsent(
  exec: DbOrTx,
  itemId: string,
): Promise<boolean> {
  const rows = await exec
    .select({ id: consent_record.id })
    .from(consent_record)
    .where(
      and(
        eq(consent_record.level, 'item'),
        eq(consent_record.consentCategory, 'profile_creation'),
        eq(consent_record.itemId, itemId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
