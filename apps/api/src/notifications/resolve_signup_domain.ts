import { eq } from 'drizzle-orm';

import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema/auth';

/**
 * The signup domain recorded on the user row (the single-role-lock `domains`
 * column), used to pick role-correct welcome copy (seeker vs provider). Reads
 * the first entry — a self-signup joins exactly one domain.
 *
 * Best-effort: returns null on a miss (domain not yet applied) or any DB error,
 * so the welcome falls back to the generic copy rather than failing signup.
 */
export async function resolveSignupDomain(userId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ domains: user.domains })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row?.domains?.[0] ?? null;
  } catch {
    return null;
  }
}
