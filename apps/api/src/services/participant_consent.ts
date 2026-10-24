import { and, eq, sql } from 'drizzle-orm';
import { items } from '@dpg/database';
import { resolveConsentVersion } from '@/services/consent_version';
import {
  hasAcceptedProfileConsent,
  hasAcceptedTermsAndPrivacy,
} from '@/services/consent_acceptance';
import { promoteItemOnProfileConsent } from '@/services/item_service';
import type { ItemEventKey as PromotedItemKey } from '@/utils/publish_item_event';
import type { DbOrTx } from '@/services/item_service';
import { consent_record } from '@api/db/postgres/schema';

/** One entry of the participant API `compliance` array. */
export interface ComplianceEntry {
  key: string;
  value: boolean;
}

export interface RecordParticipantConsentArgs {
  compliance?: ComplianceEntry[];
  userId: string;
  /** Present when a profile item was created/targeted this call. */
  itemId?: string;
  network: string;
  brand?: string | null;
  channel: 'bulk' | 'link' | 'voice' | 'self';
  acceptedAt: Date;
}

/** External compliance keys → user-level ledger categories. */
const USER_LEVEL_KEYS: Record<string, 'terms' | 'privacy'> = {
  user_terms: 'terms',
  user_privacy: 'privacy',
};
const PROFILE_CREATION_KEY = 'profile_creation';

/**
 * Records terms / privacy / profile_creation consent from the
 * `/admin/participant` `compliance` array into the consent_record ledger, and
 * promotes the profile item when profile_creation consent is present.
 *
 * Accept-only: entries other than `value === true` with a known key are
 * ignored. The document version is resolved server-side. Call inside the same
 * transaction as the user/item write so recording and promotion are atomic.
 *
 * `source` is `'signup'` for user-level rows and `'profile'` for the
 * profile_creation row, never `'guardian'`, so a minor's profile stays draft
 * under `guardianGateBlocksGoLive`.
 *
 * `/admin/participant` ignores `promoted` and reports each item's re-read
 * `lifecycle_status` instead, which reflects every gate.
 */
export async function recordParticipantConsent(
  tx: DbOrTx,
  args: RecordParticipantConsentArgs,
): Promise<{ recorded: number; promoted: boolean }> {
  const { compliance, userId, itemId, network, channel, acceptedAt } = args;
  const brand = args.brand ?? null;

  if (!compliance || compliance.length === 0) {
    return { recorded: 0, promoted: false };
  }

  const accepted = new Set(
    compliance.filter((c) => c.value === true).map((c) => c.key),
  );

  let recorded = 0;
  let promoted = false;

  // 1. User-level terms / privacy.
  for (const [key, category] of Object.entries(USER_LEVEL_KEYS)) {
    if (!accepted.has(key)) continue;
    const version = await resolveConsentVersion({ network, brand, category });
    if (version === null) continue; // category not configured: skip, do not fail onboarding
    // Skip if already recorded at this version, so a user's several profiles
    // don't duplicate user-level rows. A version bump writes a fresh row.
    const [existingUserRow] = await tx
      .select({ id: consent_record.id })
      .from(consent_record)
      .where(
        and(
          eq(consent_record.userId, userId),
          eq(consent_record.level, 'user'),
          eq(consent_record.consentCategory, category),
          eq(consent_record.network, network),
          eq(consent_record.documentVersion, version),
        ),
      )
      .limit(1);
    if (existingUserRow) continue;
    await tx.insert(consent_record).values({
      level: 'user',
      consentCategory: category,
      userId,
      network,
      brand,
      documentVersion: version,
      source: 'signup',
      acceptedAt,
      metadata: { channel, via: 'admin_participant', key },
    });
    recorded += 1;
  }

  // 2. Item-level profile_creation: needs an item and the terms/privacy
  //    prerequisite (as accept_profile_consent does). onConflictDoNothing on
  //    the partial unique index (userId, itemId, source) keeps a concurrent
  //    duplicate from aborting the outer transaction; `recorded` may then
  //    over-count by one.
  if (accepted.has(PROFILE_CREATION_KEY) && itemId) {
    const prereqMet = await hasAcceptedTermsAndPrivacy(tx, userId, network);
    if (prereqMet) {
      const alreadyRecorded = await hasAcceptedProfileConsent(tx, itemId);
      // Promote only when a profile_creation row exists or was just inserted;
      // with an unconfigured version nothing is recorded, so nothing promotes.
      let profileConsentPresent = alreadyRecorded;
      if (!alreadyRecorded) {
        const version = await resolveConsentVersion({
          network,
          brand,
          category: 'profile_creation',
        });
        if (version !== null) {
          await tx
            .insert(consent_record)
            .values({
              level: 'item',
              consentCategory: 'profile_creation',
              userId,
              itemId,
              network,
              brand,
              documentVersion: version,
              source: 'profile',
              acceptedAt,
              metadata: { channel, via: 'admin_participant', key: PROFILE_CREATION_KEY },
            })
            .onConflictDoNothing({
              target: [consent_record.userId, consent_record.itemId, consent_record.source],
              where: sql`level = 'item' AND consent_category = 'profile_creation'`,
            });
          recorded += 1;
          profileConsentPresent = true;
        }
      }
      if (profileConsentPresent) {
        promoted = await promoteItemOnProfileConsent(tx, itemId);
      }
    }
  }

  return { recorded, promoted };
}

/**
 * Promotes every `draft` item owned by `userId` that has a `profile_creation`
 * consent row. `age` is user-level, so call this after an age write: it can
 * unblock several profiles at once. Idempotent.
 *
 * Returns the key of every item flipped to `live`; the caller must publish an
 * item event for each so signals-search re-indexes it, after the surrounding
 * transaction commits.
 */
export async function promoteEligibleDraftsForUser(
  tx: DbOrTx,
  userId: string,
): Promise<PromotedItemKey[]> {
  // Sweeps drafts across all networks; each promotion still passes the
  // per-item guardian/completeness/consent gate.
  const drafts = await tx
    .select({
      item_id: items.item_id,
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
    })
    .from(items)
    .where(and(eq(items.created_by, userId), eq(items.lifecycle_status, 'draft')));
  const promoted: PromotedItemKey[] = [];
  for (const d of drafts) {
    if (await hasAcceptedProfileConsent(tx, d.item_id)) {
      if (await promoteItemOnProfileConsent(tx, d.item_id)) {
        promoted.push({
          item_network: d.item_network,
          item_domain: d.item_domain,
          item_type: d.item_type,
          item_id: d.item_id,
        });
      }
    }
  }
  return promoted;
}
