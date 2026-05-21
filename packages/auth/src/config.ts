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
                  fromEmail: 'support@onest.network',
                  replyTo: 'support@onest.network',
                  subject: `Your One-Time Password (OTP) for ${config.appName}`,
                  html: emailOtpHtmlTemplate(otp, user, config.appName),
                },
              });
            } catch (err) {
              console.error(
                'Failed to send email OTP via notification service:',
                err
              );
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
          if (!nc) return payload;

          if (payload.user.email) {
            try {
              await nc.notify({
                channel: 'email',
                template_id: 'basic_email',
                to: payload.user.email,
                priority: 'realtime',
                variables: {
                  fromName: `Welcome to ${config.appName}`,
                  fromEmail: 'support@onest.network',
                  replyTo: 'support@onest.network',
                  subject: 'Welcome!',
                  html: `<div>
                    <p>Congratulations ${payload.user.name}! You just went live with an account on ${config.appName}.</p>
                  </div>`,
                },
              });
            } catch (err) {
              console.error('Failed to send welcome email:', err);
            }
          }

          if (payload.user.phoneNumber) {
            try {
              await nc.notify({
                channel: 'whatsapp',
                template_id: 'other',
                to: payload.user.phoneNumber,
                priority: 'realtime',
                variables: {
                  contentSid: 'HX3f2a5d7e4a18e5664124592a12a154eb',
                  contentVariables: {
                    '1': payload.user.name,
                  },
                },
              });
            } catch (err) {
              console.error('Failed to send welcome WhatsApp:', err);
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
