import { peekSignupExtras } from '@/services/auth/signup_extras';

/**
 * The domain a self-signup joined, for picking role-correct welcome copy
 * (seeker vs provider). Read from the PARKED signup extras, not the user row:
 * at `afterUserCreate` time the user's `domains` column is not written yet (the
 * UI sets it later via `POST /user/domains`), so the stash is the only source.
 *
 * Best-effort — `peekSignupExtras` never throws and returns null on a miss, so
 * the welcome falls back to the generic copy rather than failing signup.
 */
export async function resolveSignupDomain(identifiers: {
  email?: string | null;
  phoneNumber?: string | null;
}): Promise<string | null> {
  const extras = await peekSignupExtras(identifiers);
  return extras?.domain ?? null;
}
