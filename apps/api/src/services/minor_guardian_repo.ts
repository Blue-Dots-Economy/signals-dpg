import { and, eq, ne, count, sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { minor_guardian, user } from '@api/db/postgres/schema';
import { encryptGuardianField, decryptGuardianField, guardianRef } from '@/services/guardian_pii';
import { apiConfig } from '@/config';
import { isMinor } from '@/services/minor';
import type { DbOrTx } from './item_service';

type GuardianContactType = 'phone' | 'email';

/**
 * How many other wards are linked to this guardian ref. `excludeUserId` (the
 * ward being re-linked) is not counted.
 */
export async function countWardsForGuardian(
  ref: string,
  excludeUserId: string | null,
  exec: DbOrTx = db,
): Promise<number> {
  const where = excludeUserId
    ? and(eq(minor_guardian.guardianRef, ref), ne(minor_guardian.userId, excludeUserId))
    : eq(minor_guardian.guardianRef, ref);
  const [row] = await exec.select({ n: count() }).from(minor_guardian).where(where);
  return row?.n ?? 0;
}

/** Thrown by the atomic cap check; call sites map it to a 409 GUARDIAN_WARD_LIMIT. */
export class WardLimitError extends Error {
  constructor() {
    super('GUARDIAN_WARD_LIMIT');
    this.name = 'WardLimitError';
  }
}

/**
 * Enforces `MAX_WARDS_PER_GUARDIAN` inside `tx`. A transaction-scoped advisory
 * lock on the ref serializes concurrent links of one guardian (the
 * `guardian_ref` index is not unique), so call it before writing the guardian
 * row in the same tx. Throws WardLimitError.
 */
export async function assertWardLimitWithLock(
  tx: DbOrTx,
  ref: string,
  excludeUserId: string | null,
): Promise<void> {
  // hashtext(ref) → int key for the advisory lock; a hash collision only causes
  // harmless extra serialization, never a missed cap.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ref}))`);
  const n = await countWardsForGuardian(ref, excludeUserId, tx);
  if (n >= apiConfig.max_wards_per_guardian) throw new WardLimitError();
}

/**
 * Unlocked pre-check: whether linking another ward to this contact would hit
 * `MAX_WARDS_PER_GUARDIAN`. `excludeUserId` is null at signup, where no ward id
 * exists yet.
 */
export async function isGuardianWardLimitReached(
  contact: string,
  excludeUserId: string | null,
): Promise<boolean> {
  const n = await countWardsForGuardian(guardianRef(contact), excludeUserId);
  return n >= apiConfig.max_wards_per_guardian;
}

/**
 * Whether a guardian email/phone equals the ward's own contact. Email is
 * compared case-insensitively, phone after trimming.
 */
export function guardianContactMatchesWard(args: {
  wardEmail?: string | null;
  wardPhone?: string | null;
  guardianEmail?: string | null;
  guardianPhone?: string | null;
}): boolean {
  const wardEmail = args.wardEmail?.trim().toLowerCase();
  const wardPhone = args.wardPhone?.trim();
  const emailMatch = !!wardEmail && !!args.guardianEmail && args.guardianEmail.trim().toLowerCase() === wardEmail;
  const phoneMatch = !!wardPhone && !!args.guardianPhone && args.guardianPhone.trim() === wardPhone;
  return emailMatch || phoneMatch;
}

/** The ward's stored age (years, snapshot at registration), or null. */
export async function getWardAge(userId: string, exec: DbOrTx = db): Promise<number | null> {
  const [row] = await exec
    .select({ age: user.age })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row?.age ?? null;
}

/** Persist the ward's age on the user row. */
export async function setWardAge(userId: string, age: number, exec: DbOrTx = db): Promise<void> {
  await exec.update(user).set({ age, updatedAt: new Date() }).where(eq(user.id, userId));
}

/**
 * The age-present and under-18 gate shared by the consent handlers. Callers map
 * the failure codes to 409.
 */
export type MinorWardCheck =
  | { ok: true; age: number }
  | { ok: false; code: 'DOB_REQUIRED' | 'NOT_A_MINOR' };
export async function requireMinorWard(userId: string, exec: DbOrTx = db): Promise<MinorWardCheck> {
  const age = await getWardAge(userId, exec);
  if (age === null) return { ok: false, code: 'DOB_REQUIRED' };
  if (!isMinor(age)) return { ok: false, code: 'NOT_A_MINOR' };
  return { ok: true, age };
}

export async function getMinorGuardian(userId: string): Promise<{
  guardianContactType: GuardianContactType | null;
  guardianVerified: boolean;
} | null> {
  const [row] = await db
    .select({
      guardianContactType: minor_guardian.guardianContactType,
      guardianVerified: minor_guardian.guardianVerified,
    })
    .from(minor_guardian)
    .where(eq(minor_guardian.userId, userId))
    .limit(1);
  if (!row) return null;
  return {
    guardianContactType: (row.guardianContactType as GuardianContactType | null) ?? null,
    guardianVerified: row.guardianVerified,
  };
}

/**
 * Resolves the OTP channel from the guardian contacts; phone is preferred when
 * both are given. Throws if neither is present.
 */
export function resolveOtpChannel(input: {
  guardianEmail?: string | null;
  guardianPhone?: string | null;
}): { contact: string; contactType: GuardianContactType } {
  if (input.guardianPhone) return { contact: input.guardianPhone, contactType: 'phone' };
  if (input.guardianEmail) return { contact: input.guardianEmail, contactType: 'email' };
  throw new Error('resolveOtpChannel: at least one guardian contact is required');
}

/**
 * Stores guardian details with name and contacts encrypted at rest, and resets
 * verified. Both contacts are kept; `guardian_contact`/`_type` hold the OTP
 * channel so the OTP and resend paths have a single target.
 */
export async function upsertGuardianDetails(
  userId: string,
  input: { guardianName: string; guardianEmail?: string | null; guardianPhone?: string | null },
): Promise<void> {
  const channel = resolveOtpChannel(input);
  const ref = guardianRef(channel.contact);
  // Upsert: this may be the first write of the ward's row.
  const fields = {
    guardianName: encryptGuardianField(input.guardianName),
    guardianContact: encryptGuardianField(channel.contact),
    guardianContactType: channel.contactType,
    guardianEmail: input.guardianEmail ? encryptGuardianField(input.guardianEmail) : null,
    guardianPhone: input.guardianPhone ? encryptGuardianField(input.guardianPhone) : null,
    guardianRef: ref,
    guardianVerified: false,
  };
  await db.transaction(async (tx) => {
    await assertWardLimitWithLock(tx, ref, userId);
    await tx
      .insert(minor_guardian)
      .values({ userId, ...fields })
      .onConflictDoUpdate({
        target: minor_guardian.userId,
        set: { ...fields, updatedAt: new Date() },
      });
  });
}

/** Decrypt the guardian contact for a transient use (OTP send). */
export async function getGuardianContactPlaintext(
  userId: string,
): Promise<{ contact: string; contactType: GuardianContactType } | null> {
  const [row] = await db
    .select({
      guardianContact: minor_guardian.guardianContact,
      guardianContactType: minor_guardian.guardianContactType,
    })
    .from(minor_guardian)
    .where(eq(minor_guardian.userId, userId))
    .limit(1);
  if (!row?.guardianContact || !row.guardianContactType) return null;
  return {
    contact: decryptGuardianField(row.guardianContact),
    contactType: row.guardianContactType as GuardianContactType,
  };
}

/** Decrypt the guardian's name for a transient use (email/SMS template var). */
export async function getGuardianNamePlaintext(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ guardianName: minor_guardian.guardianName })
    .from(minor_guardian)
    .where(eq(minor_guardian.userId, userId))
    .limit(1);
  return row?.guardianName ? decryptGuardianField(row.guardianName) : null;
}

export async function setGuardianVerified(userId: string): Promise<void> {
  await db
    .update(minor_guardian)
    .set({ guardianVerified: true, updatedAt: new Date() })
    .where(eq(minor_guardian.userId, userId));
}

/**
 * Writes already-encrypted guardian blobs without re-encrypting them, for the
 * pre-auth signup flow (`signup_guardian.ts`). Sets `guardian_verified` true:
 * its only caller has already verified the guardian OTP.
 */
export async function writeEncryptedGuardian(
  userId: string,
  input: {
    guardianNameEnc: string;
    guardianContactEnc: string;
    guardianContactType: GuardianContactType;
    guardianEmailEnc?: string | null;
    guardianPhoneEnc?: string | null;
    guardianRef?: string | null;
  },
  exec: DbOrTx = db,
): Promise<void> {
  const fields = {
    guardianName: input.guardianNameEnc,
    guardianContact: input.guardianContactEnc,
    guardianContactType: input.guardianContactType,
    guardianEmail: input.guardianEmailEnc ?? null,
    guardianPhone: input.guardianPhoneEnc ?? null,
    guardianRef: input.guardianRef ?? null,
    guardianVerified: true,
  };
  await exec
    .insert(minor_guardian)
    .values({ userId, ...fields })
    .onConflictDoUpdate({
      target: minor_guardian.userId,
      set: { ...fields, updatedAt: new Date() },
    });
}
