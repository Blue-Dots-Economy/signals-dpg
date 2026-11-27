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
 * Post-signup side effects for a new user. Both steps are best-effort; neither
 * may fail signup:
 *
 *  1. Materialize a verified pre-auth signup-guardian capture onto the new id.
 *  2. Send the welcome email/WhatsApp, with copy chosen by the parked signup
 *     domain.
 *
 * Only tests call this; first-login provisioning (`provisioning.ts`) runs the
 * same steps itself.
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
    // No request logger here, so failures go to the console.
    { error: (details, message) => console.error(message, details) },
    signupDomain,
  );
}
