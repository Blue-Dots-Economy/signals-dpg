import { and, eq, ne, count } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { minor_guardian, user } from '@api/db/postgres/schema';
import { encryptGuardianField, decryptGuardianField, guardianRef } from '@/services/guardian_pii';
import { apiConfig } from '@/config';
import { isMinor } from '@/services/minor';
import type { DbOrTx } from './item_service';

type GuardianContactType = 'phone' | 'email';

/**
 * How many OTHER wards are already linked to this guardian contact (matched by
 * the deterministic guardian ref). Excludes `excludeUserId` (the ward being
 * (re)linked) so re-submitting the same guardian for the same ward doesn't
 * count against the cap.
 */
export async function countWardsForGuardian(
  ref: string,
  excludeUserId: string | null,
): Promise<number> {
  const where = excludeUserId
    ? and(eq(minor_guardian.guardianRef, ref), ne(minor_guardian.userId, excludeUserId))
    : eq(minor_guardian.guardianRef, ref);
  const [row] = await db.select({ n: count() }).from(minor_guardian).where(where);
  return row?.n ?? 0;
}

/**
 * Whether linking another ward to this guardian contact would hit the cap
 * (`MAX_WARDS_PER_GUARDIAN`). `excludeUserId` is the ward being re-linked (so
 * updating an existing ward's guardian doesn't count them twice), or null at
 * signup where no ward id exists yet. Wraps the guardianRef + count + threshold
 * so both the route and the pre-auth signup flow apply the same rule.
 */
export async function isGuardianWardLimitReached(
  contact: string,
  excludeUserId: string | null,
): Promise<boolean> {
  const n = await countWardsForGuardian(guardianRef(contact), excludeUserId);
  return n >= apiConfig.max_wards_per_guardian;
}

/**
 * Warn-and-ack guard: whether a guardian email/phone equals the ward's own
 * contact. Email compared case-insensitively, phone trimmed — matching how both
 * call sites normalized before this was centralized.
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

/** The ward's date of birth (full date), stored on the user row. */
export async function getWardDob(userId: string, exec: DbOrTx = db): Promise<Date | null> {
  const [row] = await exec
    .select({ dob: user.dateOfBirth })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row?.dob ?? null;
}

/** Persist the ward's date of birth on the user row. */
export async function setWardDob(userId: string, dob: Date, exec: DbOrTx = db): Promise<void> {
  await exec.update(user).set({ dateOfBirth: dob, updatedAt: new Date() }).where(eq(user.id, userId));
}

/**
 * The DOB-present + under-18 gate shared by the consent handlers. Returns the
 * DOB on success, or a typed reason (DOB_REQUIRED / NOT_A_MINOR) callers map to
 * 409 — so the pair isn't re-inlined per handler.
 */
export type MinorWardCheck =
  | { ok: true; dob: Date }
  | { ok: false; code: 'DOB_REQUIRED' | 'NOT_A_MINOR' };
export async function requireMinorWard(userId: string, exec: DbOrTx = db): Promise<MinorWardCheck> {
  const dob = await getWardDob(userId, exec);
  if (!dob) return { ok: false, code: 'DOB_REQUIRED' };
  if (!isMinor(dob)) return { ok: false, code: 'NOT_A_MINOR' };
  return { ok: true, dob };
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
 * Resolve the single OTP channel from the two guardian contacts — phone is
 * preferred when both are given (per the U18 spec's channel order). Throws if
 * neither is present (callers validate at least one upstream).
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
 * Store guardian details, name + contacts encrypted at rest. Resets verified.
 * Persists BOTH contacts the guardian supplied; `guardian_contact`/`_type`
 * mirror the resolved OTP channel (phone preferred) so the OTP + resend path
 * has a single target to read back.
 */
export async function upsertGuardianDetails(
  userId: string,
  input: { guardianName: string; guardianEmail?: string | null; guardianPhone?: string | null },
): Promise<void> {
  const channel = resolveOtpChannel(input);
  // Upsert: DOB no longer creates a minor_guardian row (it lives on user now),
  // so this may be the first write of the ward's row.
  const fields = {
    guardianName: encryptGuardianField(input.guardianName),
    guardianContact: encryptGuardianField(channel.contact),
    guardianContactType: channel.contactType,
    guardianEmail: input.guardianEmail ? encryptGuardianField(input.guardianEmail) : null,
    guardianPhone: input.guardianPhone ? encryptGuardianField(input.guardianPhone) : null,
    guardianRef: guardianRef(channel.contact),
    guardianVerified: false,
  };
  await db
    .insert(minor_guardian)
    .values({ userId, ...fields })
    .onConflictDoUpdate({
      target: minor_guardian.userId,
      set: { ...fields, updatedAt: new Date() },
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

export async function setGuardianVerified(userId: string): Promise<void> {
  await db
    .update(minor_guardian)
    .set({ guardianVerified: true, updatedAt: new Date() })
    .where(eq(minor_guardian.userId, userId));
}

/**
 * Write an ALREADY-ENCRYPTED guardian name/contact blob directly — no
 * re-encryption. Used by the pre-auth signup-guardian flow (services/
 * signup_guardian.ts): the guardian PII is encrypted before the ward's
 * account exists (keyed on the signup identifier in Redis) and is
 * materialized onto the new user id verbatim once the account is created.
 * Marks `guardian_verified` true — the pre-auth flow only calls this after
 * its own OTP verify has already flipped the pending record's `verified`
 * flag, so re-verification here would be redundant.
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
