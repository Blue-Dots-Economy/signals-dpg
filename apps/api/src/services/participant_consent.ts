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
 * Records terms / privacy / profile_creation consent sent by an external
 * channel (voice / aggregator / bulk) through the `/admin/participant`
 * `compliance` array into the consent_record ledger, and promotes the profile
 * item to `live` when profile_creation consent is accepted.
 *
 * Accept-only: only entries with `value === true` are recorded; `false`,
 * absent, and unknown keys are ignored. The document version is derived
 * server-side (never trusted from the client). Call this inside the same
 * transaction as the user/item write so recording + promotion are atomic; a
 * failure rolls the whole write back.
 *
 * `source` is `'signup'` for user-level rows and `'profile'` for the item-level
 * `profile_creation` row — deliberately never `'guardian'`, so a minor's
 * profile stays draft under `guardianGateBlocksGoLive` inside
 * `promoteItemOnProfileConsent`.
 */
/**
 * Note on the returned `promoted` flag: the `/admin/participant` handler does
 * NOT consume it — it reports go-live to callers via each item's freshly-read
 * `lifecycle_status` in the response instead (a single source of truth that
 * also reflects any other gate, e.g. the minor/guardian hold). `promoted` is
 * therefore primarily for tests and other callers that want the decision
 * inline without a re-read; the handler is not "forgetting" to use it.
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
    if (version === null) continue; // category not configured — skip, do not fail onboarding
    // Dedupe: skip if this user already has this category recorded at the
    // current version (avoids duplicate user-level rows across a user's
    // multiple profiles). A version bump writes a fresh row.
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

  // 2. Item-level profile_creation — needs an item AND the terms/privacy
  //    prerequisite (mirrors accept_profile_consent). Pre-check presence to
  //    stay idempotent; the insert is ALSO conflict-safe via
  //    onConflictDoNothing on the partial unique index
  //    consent_record_profile_creation_unique (userId,itemId,source), so two
  //    concurrent calls that both pass the !alreadyRecorded pre-check no longer
  //    23505-abort the outer transaction — the loser is a silent no-op. (A rare
  //    concurrent race can over-count `recorded` by one; harmless — the ledger
  //    still holds exactly one row.)
  if (accepted.has(PROFILE_CREATION_KEY) && itemId) {
    const prereqMet = await hasAcceptedTermsAndPrivacy(tx, userId, network);
    if (prereqMet) {
      const alreadyRecorded = await hasAcceptedProfileConsent(tx, itemId);
      // Only promote when profile_creation consent is actually present — either
      // a prior row exists, or we just inserted one. Never promote on the path
      // where the version is unconfigured and nothing was recorded (that would
      // flip the item live with zero ledger evidence — consent gates
      // discoverability).
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
      // Promote whenever profile_creation consent is present (new or existing).
      if (profileConsentPresent) {
        promoted = await promoteItemOnProfileConsent(tx, itemId);
      }
    }
  }

  return { recorded, promoted };
}

/**
 * Promotes every `draft` item owned by `userId` that already has a
 * `profile_creation` consent row. Because `age` is user-level,
 * persisting it can unblock several of the user's profiles at once — call this
 * after an age write. Idempotent: `promoteItemOnProfileConsent` no-ops on items
 * that are not `draft` or that the guardian/completeness gate still blocks.
 *
 * Returns the KEY of every item actually flipped to `live` (#557), not a count:
 * the caller must publish an item event per promotion so signals-search
 * re-indexes it, and these promotions are collateral — the caller has no other
 * way to know which of the user's profiles moved. Publish AFTER the surrounding
 * transaction commits, never inside it.
 */
export async function promoteEligibleDraftsForUser(
  tx: DbOrTx,
  userId: string,
): Promise<PromotedItemKey[]> {
  // Intentionally sweeps the user's drafts across all networks; each
  // promotion still passes the per-item guardian/completeness/consent gate.
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
