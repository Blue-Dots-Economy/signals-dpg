import { and, eq, ne, count } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { minor_guardian } from '@api/db/postgres/schema';
import { encryptGuardianField, decryptGuardianField, guardianRef } from '@/services/guardian_pii';

type GuardianContactType = 'phone' | 'email';
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

/** Max wards that may share one guardian contact (product cap; best-effort). */
export const MAX_WARDS_PER_GUARDIAN = 6;

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

/** Insert or update the ward's birth year/month (no exact day). */
export async function upsertBirthMonth(
  userId: string,
  birthYear: number,
  birthMonth: number,
): Promise<void> {
  await db
    .insert(minor_guardian)
    .values({ userId, birthYear, birthMonth })
    .onConflictDoUpdate({
      target: minor_guardian.userId,
      set: { birthYear, birthMonth, updatedAt: new Date() },
    });
}

export async function getMinorGuardian(userId: string): Promise<{
  birthYear: number;
  birthMonth: number;
  guardianContactType: GuardianContactType | null;
  guardianVerified: boolean;
} | null> {
  const [row] = await db
    .select({
      birthYear: minor_guardian.birthYear,
      birthMonth: minor_guardian.birthMonth,
      guardianContactType: minor_guardian.guardianContactType,
      guardianVerified: minor_guardian.guardianVerified,
    })
    .from(minor_guardian)
    .where(eq(minor_guardian.userId, userId))
    .limit(1);
  if (!row) return null;
  return {
    birthYear: row.birthYear,
    birthMonth: row.birthMonth,
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
  await db
    .update(minor_guardian)
    .set({
      guardianName: encryptGuardianField(input.guardianName),
      guardianContact: encryptGuardianField(channel.contact),
      guardianContactType: channel.contactType,
      guardianEmail: input.guardianEmail ? encryptGuardianField(input.guardianEmail) : null,
      guardianPhone: input.guardianPhone ? encryptGuardianField(input.guardianPhone) : null,
      guardianRef: guardianRef(channel.contact),
      guardianVerified: false,
      updatedAt: new Date(),
    })
    .where(eq(minor_guardian.userId, userId));
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
    birthYear: number;
    birthMonth: number;
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
    birthYear: input.birthYear,
    birthMonth: input.birthMonth,
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
