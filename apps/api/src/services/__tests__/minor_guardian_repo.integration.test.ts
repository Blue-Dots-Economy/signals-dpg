import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { minor_guardian } from '@api/db/postgres/schema';
import {
  upsertBirthMonth,
  getMinorGuardian,
  upsertGuardianDetails,
  getGuardianContactPlaintext,
  setGuardianVerified,
} from '@/services/minor_guardian_repo';

const uid = 'test-u18-repo-user';

afterAll(async () => {
  await db.delete(minor_guardian).where(eq(minor_guardian.userId, uid));
});

describe('minor_guardian_repo (integration)', () => {
  it('upserts birth month and reads it back', async () => {
    await upsertBirthMonth(uid, 2010, 6);
    const row = await getMinorGuardian(uid);
    expect(row).toMatchObject({ birthYear: 2010, birthMonth: 6, guardianVerified: false });
  });

  it('stores guardian details encrypted, decrypts contact, and flips verified', async () => {
    await upsertGuardianDetails(uid, {
      guardianName: 'Parent Name',
      guardianEmail: 'parent@x.co',
    });
    // stored ciphertext is not the plaintext
    const [raw] = await db
      .select({ c: minor_guardian.guardianContact })
      .from(minor_guardian)
      .where(eq(minor_guardian.userId, uid));
    expect(raw.c).not.toBe('parent@x.co');
    // decrypts back
    expect(await getGuardianContactPlaintext(uid)).toEqual({ contact: 'parent@x.co', contactType: 'email' });
    // verify flip
    await setGuardianVerified(uid);
    expect((await getMinorGuardian(uid))?.guardianVerified).toBe(true);
  });
});
