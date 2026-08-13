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
import { getDefaultEmailSender } from '@/notifications/email/dispatch_email';
import { materializeSignupGuardian } from '@/services/signup_guardian';

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

  // Central email dispatch (#529): login-OTP + welcome copy live in the email
  // messages file; criticality comes from the case registry (login.otp
  // critical → throws → OTP_DELIVERY_FAILED 502; welcome best-effort → the
  // sender swallows failures). Only wired when a notification client exists,
  // preserving the package's console fallback for local dev.
  ...(getNotificationClient()
    ? {
        sendEmail: async (args: {
          caseId: 'login.otp' | 'welcome';
          to: string;
          fromName: string;
          variables: Record<string, string>;
        }) => {
          const sender = getDefaultEmailSender();
          if (!sender) throw new Error('email sender not configured');
          await sender.dispatchEmail({
            ...args,
            variables: {
              ...args.variables,
              // App-side context the auth package can't know: the platform
              // link and the "Team <name>" sign-off used by the copy file.
              siteUrl: notification.FRONTEND_BASE_URL ?? '',
              teamName: instance.INSTANCE_NAME ?? 'DPG',
            },
          });
        },
      }
    : {}),

  allowSelfSignup: authConfig.allow_self_signup,
  loginChannels: authConfig.login_channels,

  // Materialize a pre-auth signup-guardian capture (services/signup_guardian.ts)
  // onto the new user id, only for genuinely new users. Never blocks signup —
  // failures are caught and logged here (createAuth also wraps this call, so
  // this is defense in depth, not the only safety net).
  afterUserCreate: async ({ user }) => {
    try {
      await materializeSignupGuardian(user);
    } catch (err) {
      console.error('materializeSignupGuardian failed:', err);
    }
  },
});
