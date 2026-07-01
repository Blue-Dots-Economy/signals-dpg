import { describe, it, expect } from 'vitest';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import { eq } from 'drizzle-orm';

describe('consent_record table', () => {
  it('inserts and reads a user-level row', async () => {
    const userId = `test-user-${Date.now()}`;
    await db.insert(consent_record).values({
      level: 'user',
      consentCategory: 'terms',
      userId,
      network: 'blue_dot',
      documentVersion: 1,
      source: 'signup',
      acceptedAt: new Date(),
    });
    const rows = await db
      .select()
      .from(consent_record)
      .where(eq(consent_record.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].consentCategory).toBe('terms');
    expect(rows[0].seq).toBeGreaterThan(0);
  });
});
