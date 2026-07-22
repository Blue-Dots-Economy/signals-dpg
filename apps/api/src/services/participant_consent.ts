import { resolveConsentVersion } from '@/services/consent_version';
import {
  hasAcceptedProfileConsent,
  hasAcceptedTermsAndPrivacy,
} from '@/services/consent_acceptance';
import {
  promoteItemOnProfileConsent,
  type DbOrTx,
} from '@/services/item_service';
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
  //    stay idempotent without relying on a 23505 inside the transaction
  //    (which would abort it).
  if (accepted.has(PROFILE_CREATION_KEY) && itemId) {
    const prereqMet = await hasAcceptedTermsAndPrivacy(tx, userId, network);
    if (prereqMet) {
      const alreadyRecorded = await hasAcceptedProfileConsent(tx, itemId);
      if (!alreadyRecorded) {
        const version = await resolveConsentVersion({
          network,
          brand,
          category: 'profile_creation',
        });
        if (version !== null) {
          await tx.insert(consent_record).values({
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
          });
          recorded += 1;
        }
      }
      // Promote whenever profile_creation consent is present (new or existing).
      promoted = await promoteItemOnProfileConsent(tx, itemId);
    }
  }

  return { recorded, promoted };
}
