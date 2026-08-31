import { materializeSignupGuardian } from '@/services/signup_guardian';
import { sendWelcomeNotifications } from '@/notifications/welcome';
import { resolveSignupDomain } from '@/notifications/resolve_signup_domain';

/** Just enough of a freshly-created user to run the post-signup side effects. */
export interface CreatedUser {
  id: string;
  name: string;
  email?: string | null;
  phoneNumber?: string | null;
}

/**
 * Post-signup side effects for a genuinely-new user, extracted from the
 * better-auth `afterUserCreate` hook so they're unit-testable (the hook itself
 * lives in the untestable auth-config module). Both steps are best-effort — a
 * parked-guardian materialisation or a welcome message must never fail signup:
 *
 *  1. Materialize a verified pre-auth signup-guardian capture onto the new id.
 *  2. Send the welcome email/WhatsApp, with role-correct copy resolved from the
 *     parked signup domain (seeker vs provider).
 */
export async function runAfterUserCreate(user: CreatedUser): Promise<void> {
  try {
    await materializeSignupGuardian(user);
  } catch (err) {
    console.error('materializeSignupGuardian failed:', err);
  }

  const signupDomain = await resolveSignupDomain({
    email: user.email ?? null,
    phoneNumber: user.phoneNumber ?? null,
  });

  await sendWelcomeNotifications(
    { name: user.name, email: user.email ?? null, phoneNumber: user.phoneNumber ?? null },
    // No request context in a module-level hook, so failures go to the console.
    { error: (details, message) => console.error(message, details) },
    signupDomain,
  );
}
