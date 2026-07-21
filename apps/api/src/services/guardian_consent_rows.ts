/**
 * Builders for the U18 guardian `consent_record` rows. Every guardian-sourced
 * consent row shares the same skeleton — `source`, the `{ variant: 'u18' }`
 * metadata, `acceptedAt`, the level/category — and only the ids/version differ.
 * Hand-writing that skeleton per call site (5+ places across signup, the
 * guardian routes, the profile-consent routes, and both action handlers) is the
 * spot where a field (`source: 'guardian'` vs `'self'`, a missing `variant`)
 * silently drifts. Route every write through these so the shape is one thing.
 *
 * Callers still own version resolution + the actual insert/upsert (their
 * null-version and error handling differ), so these are pure value builders.
 */
import { consent_record } from '@api/db/postgres/schema';

type ConsentInsert = typeof consent_record.$inferInsert;

/** User-level U18 consent (terms / privacy / guardian_declaration). */
export function guardianUserConsentRow(args: {
  category: 'terms' | 'privacy' | 'guardian_declaration';
  userId: string;
  network: string;
  brand?: string | null;
  documentVersion: number;
  /** `guardian_declaration` is the ward's own attestation ('self'); terms/privacy are 'guardian'. */
  source: 'self' | 'guardian';
  acceptedAt?: Date;
}): ConsentInsert {
  return {
    level: 'user',
    consentCategory: args.category,
    userId: args.userId,
    network: args.network,
    brand: args.brand ?? null,
    documentVersion: args.documentVersion,
    source: args.source,
    acceptedAt: args.acceptedAt ?? new Date(),
    metadata: { variant: 'u18' },
  };
}

/** Item-level guardian `profile_creation` consent (used for insert + upsert). */
export function guardianProfileConsentRow(args: {
  userId: string;
  itemId: string;
  network: string;
  brand?: string | null;
  documentVersion: number;
  acceptedAt?: Date;
}): ConsentInsert {
  return {
    level: 'item',
    consentCategory: 'profile_creation',
    userId: args.userId,
    itemId: args.itemId,
    network: args.network,
    brand: args.brand ?? null,
    documentVersion: args.documentVersion,
    source: 'guardian',
    acceptedAt: args.acceptedAt ?? new Date(),
    metadata: { variant: 'u18' },
  };
}

/**
 * Item-level `action` consent row (perform → initiate, accept → accept). Covers
 * both the adult self path (`source: 'action'`, no variant) and the guardian
 * path (`source: 'guardian'`, `variant: 'u18'`) — the near-twin writes in the
 * two action handlers. `variant` present ⇒ the u18 metadata is attached.
 */
export function actionConsentRow(args: {
  actionType: string;
  actionStage: 'initiate' | 'accept';
  userId: string;
  itemId: string;
  actionId: string;
  network: string;
  brand?: string | null;
  documentVersion: number;
  source: 'action' | 'guardian';
  variant?: 'u18';
  acceptedAt?: Date;
}): ConsentInsert {
  return {
    level: 'item',
    consentCategory: 'action',
    actionType: args.actionType,
    actionStage: args.actionStage,
    userId: args.userId,
    itemId: args.itemId,
    actionId: args.actionId,
    network: args.network,
    brand: args.brand ?? null,
    documentVersion: args.documentVersion,
    source: args.source,
    acceptedAt: args.acceptedAt ?? new Date(),
    ...(args.variant ? { metadata: { variant: args.variant } } : {}),
  };
}

/** Guardian variant of {@link actionConsentRow} — the common u18 case. */
export function guardianActionConsentRow(args: {
  actionType: string;
  actionStage: 'initiate' | 'accept';
  userId: string;
  itemId: string;
  actionId: string;
  network: string;
  brand?: string | null;
  documentVersion: number;
  acceptedAt?: Date;
}): ConsentInsert {
  return actionConsentRow({ ...args, source: 'guardian', variant: 'u18' });
}
