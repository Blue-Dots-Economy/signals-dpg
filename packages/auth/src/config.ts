import { betterAuth } from 'better-auth/minimal';
import { admin, bearer, openAPI, organization } from 'better-auth/plugins';
import { apiKey, type ApiKeyConfigurationOptions } from '@better-auth/api-key';
import { unifiedOtp } from '../plugins/unified_otp';
import type { AuthRuntimeConfig } from './types';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOtpHtmlTemplate } from './templates/otp_email';

export function createAuth(config: AuthRuntimeConfig) {
  const redis = config.redis;
  const nc = config.notificationClient;
  const apiKeyConfig: ApiKeyConfigurationOptions = {
    rateLimit: {
      timeWindow: 1000 * 60 * 60,
      maxRequests: 10000,
    },
    requireName: true,
    apiKeyHeaders: 'x-api-key',
    defaultPrefix: `${config.appName.toLowerCase()}_`,
    enableMetadata: true,
    enableSessionForAPIKeys: true,
  };

  return betterAuth({
    appName: config.appName,
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,

    advanced: {
      database: {
        generateId: () => crypto.randomUUID(),
      },
      disableCSRFCheck: config.nodeEnv !== 'production',
      disableOriginCheck: config.nodeEnv !== 'production',
      useSecureCookies: config.nodeEnv === 'production',

      crossSubDomainCookies: {
        enabled: false,
      },

      defaultCookieAttributes: {
        sameSite: config.nodeEnv === 'production' ? 'none' : 'lax',
        secure: config.nodeEnv === 'production',
        partitioned: config.nodeEnv === 'production',
      },

      cookies: {
        sessionToken: {
          attributes: {
            sameSite: config.nodeEnv === 'production' ? 'none' : 'lax',
            secure: config.nodeEnv === 'production',
          },
        },
      },
    },

    session: {
      cookieCache: {
        enabled: true,
        maxAge: 10 * 60,
      },
    },

    rateLimit: {
      enabled: false,
    },

    database: drizzleAdapter(config.db, { provider: 'pg' }),

    secondaryStorage: {
      get: async (key) => {
        const value = await redis.get(key);
        return value ? value : null;
      },
      set: async (key, value, ttl) => {
        if (ttl) await redis.set(key, value, 'EX', ttl);
        else await redis.set(key, value, 'EX', 600);
      },
      delete: async (key) => {
        await redis.del(key);
      },
    },

    emailAndPassword: {
      enabled: true,
    },

    plugins: [
      openAPI({ theme: 'none' }),
      bearer(),

      admin({
        defaultRole: 'user',
        adminRoles: ['admin'],
      }),

      organization({
        schema: {
          organization: {
            additionalFields: {
              type: {
                type: 'string',
                input: true,
                required: false,
                sortable: true,
                defaultValue: 'employer',
              },
            },
          },
        },
      }),

      unifiedOtp({
        adminByDomain: config.adminDomains,
        allowSelfSignup: config.allowSelfSignup,
        loginChannels: config.loginChannels,

        sendPhoneOtp: async ({ phoneNumber, otp }) => {
          if (nc) {
            try {
              await nc.notify({
                channel: 'sms',
                template_id: config.smsTemplateId || 'login_otp',
                to: phoneNumber,
                priority: 'realtime',
                variables: { message: otp },
              });
            } catch (err) {
              console.error(
                'Failed to send phone OTP via notification service:',
                err
              );
              // Propagate so the OTP endpoint can report the delivery failure
              // instead of returning ok:true for a code that never arrived.
              throw err;
            }
          } else {
            console.log({ phoneNumber, message: `Your OTP: ${otp}` });
          }
        },

        sendEmailOtp: async ({ email, otp, user }) => {
          if (nc) {
            try {
              await nc.notify({
                channel: 'email',
                template_id: 'basic_email',
                to: email,
                priority: 'realtime',
                variables: {
                  fromName: config.appName,
                  fromEmail: 'hello@bluedotseconomy.org',
                  replyTo: 'hello@bluedotseconomy.org',
                  subject: `Your One-Time Password (OTP) for ${config.appName}`,
                  html: emailOtpHtmlTemplate(otp, user, config.appName),
                },
              });
            } catch (err) {
              console.error(
                'Failed to send email OTP via notification service:',
                err
              );
              // Propagate so the OTP endpoint can report the delivery failure
              // instead of returning ok:true for a code that never arrived.
              throw err;
            }
          } else {
            console.log({
              to: email,
              subject: 'Your One-Time Password',
              html: otp || user,
            });
          }
        },

        afterUserCreate: async (payload) => {
          // The welcome email + WhatsApp used to be sent inline here. They now
          // live in apps/api's `sendWelcomeNotifications` and are invoked from
          // the caller hook below, because a hook that only this plugin calls is
          // unreachable once better-auth stops running — a user provisioned from
          // a Keycloak token got no welcome at all (G1 of
          // docs/superpowers/plans/2026-07-31-replace-better-auth-with-keycloak.md).
          // Keeping them behind one shared hook is what stops the two identity
          // paths sending different things.

          // Caller-supplied signup-completion hook (materializing a pre-auth
          // signup-guardian capture onto the new user, and the welcome
          // notifications). Always runs, independent of whether a notification
          // client is configured — never let a failure here block or fail the
          // signup response.
          if (config.afterUserCreate) {
            try {
              await config.afterUserCreate(payload);
            } catch (err) {
              console.error('afterUserCreate hook failed:', err);
            }
          }

          return payload;
        },

        createTestOtp: config.createTestOTP,
      }),
      apiKey(apiKeyConfig),
    ],
  });
}
