/**
 * Pure builders for U18 guardian `consent_record` rows, so every call site
 * writes the same `source` and `{ variant: 'u18' }` metadata. Callers own
 * version resolution and the insert.
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
 * Item-level `action` consent row (perform → initiate, accept → accept), for
 * both the adult path (`source: 'action'`) and the guardian path
 * (`source: 'guardian'`, `variant: 'u18'`). The variant metadata is attached
 * only when `variant` is set.
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
