import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import type { DbOrTx } from './item_service';

/**
 * True when the user has accepted BOTH terms and privacy for the network at
 * user level. This is the PREREQUISITE for recording per-profile consent — the
 * `/consent/profile-accept` endpoint enforces it so `profile_creation` can
 * never exist without terms + privacy already accepted. That invariant lets
 * the live gate check the item-level profile consent alone
 * (`hasAcceptedProfileConsent`).
 *
 * Ledger is append-only → presence of a row = accepted (any version).
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
 * True when `profile_creation` consent has been accepted for this specific
 * item. This is the consent gate for making a profile live (aggregator-dpg#464):
 * a profile goes live only when required fields are complete AND this consent
 * exists. Because `/consent/profile-accept` enforces terms + privacy first,
 * this single item-level check also implies user-level consent.
 *
 * Keyed on `itemId` ALONE — deliberately not on the accepting user — so it
 * matches `promoteItemOnProfileConsent`. Keying it on the item's `created_by`
 * would miss consent recorded under a different accepting user (on-behalf /
 * bulk profiles), promoting the item live on consent but then demoting it on
 * its next edit. `consent_record`'s partial unique index already keeps
 * profile_creation to one row per (user, item).
 *
 * Source of truth is `consent_record`, not the user-table flags (those retire
 * via signals-dpg#270).
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
