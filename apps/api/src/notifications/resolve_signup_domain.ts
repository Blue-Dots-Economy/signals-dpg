import { peekSignupExtras } from '@/services/auth/signup_extras';

/**
 * The domain a self-signup joined, read from the parked signup extras without
 * consuming them. Never throws; null on a miss.
 */
export async function resolveSignupDomain(identifiers: {
  email?: string | null;
  phoneNumber?: string | null;
}): Promise<string | null> {
  const extras = await peekSignupExtras(identifiers);
  return extras?.domain ?? null;
}
