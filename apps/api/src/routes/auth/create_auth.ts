import { createAuth } from '@dpg/auth';
import { allowed_origins, admin_domains } from '@dpg/config';
import {
  api,
  instance,
  auth,
  notification,
  authConfig,
  getCurrentApiBaseUrl,
} from '@/config';
import { db } from '@api/db/postgres/drizzle_config';
import { redis } from '@api/db/secondary/redis';
import { getNotificationClient } from '@/utils/notificationClient';
import { materializeSignupGuardian } from '@/services/signup_guardian';
import { sendWelcomeNotifications } from '@/notifications/welcome';

export const authInstance = createAuth({
  appName: instance.INSTANCE_NAME ?? 'DPG',
  nodeEnv: instance.INSTANCE_ENV,

  // getCurrentApiBaseUrl() only appends API_PORT when API_DOMAIN doesn't
  // already carry one; a naive `${api.API_DOMAIN}:${api.API_PORT}` (the
  // prior form here) double-appended the port whenever API_DOMAIN was
  // already a full origin like "http://localhost:2742", which better-auth's
  // URL parsing rejects outright.
  baseURL: `${getCurrentApiBaseUrl()}/api/auth`,

  secret: auth.AUTH_SECRET,
  apiDomain: api.API_DOMAIN,

  trustedOrigins: allowed_origins,
  adminDomains: admin_domains,

  db: db,
  redis: redis,

  createTestOTP: auth.CREATE_TEST_OTP,
  notificationClient: getNotificationClient(),
  smsTemplateId: notification.SMS_TEMPLATE_ID,

  allowSelfSignup: authConfig.allow_self_signup,
  loginChannels: authConfig.login_channels,

  // Post-signup work for genuinely new users, both best-effort. Never blocks
  // signup — failures are caught and logged here (createAuth also wraps this
  // call, so this is defense in depth, not the only safety net).
  //
  //  1. Materialize a pre-auth signup-guardian capture
  //     (services/signup_guardian.ts) onto the new user id.
  //  2. Send the welcome notifications. These live in apps/api rather than in
  //     packages/auth so the Keycloak path (which never runs better-auth) sends
  //     the identical messages — see notifications/welcome.ts.
  afterUserCreate: async ({ user }) => {
    try {
      await materializeSignupGuardian(user);
    } catch (err) {
      console.error('materializeSignupGuardian failed:', err);
    }

    await sendWelcomeNotifications(
      {
        name: user.name,
        email: user.email ?? null,
        phoneNumber: user.phoneNumber ?? null,
      },
      // No request context in a module-level hook, so failures go to the
      // console here exactly as the surrounding code already does.
      { error: (details, message) => console.error(message, details) }
    );
  },
});
