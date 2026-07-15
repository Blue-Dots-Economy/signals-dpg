import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { minor_guardian } from '@api/db/postgres/schema';
import { encryptGuardianField, decryptGuardianField } from '@/services/guardian_pii';

type GuardianContactType = 'phone' | 'email';

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

/** Store guardian details with name + contact encrypted at rest. Resets verified. */
export async function upsertGuardianDetails(
  userId: string,
  input: { guardianName: string; guardianContact: string; guardianContactType: GuardianContactType },
): Promise<void> {
  await db
    .update(minor_guardian)
    .set({
      guardianName: encryptGuardianField(input.guardianName),
      guardianContact: encryptGuardianField(input.guardianContact),
      guardianContactType: input.guardianContactType,
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
