import { type User } from 'better-auth';
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from 'better-auth/api';
import { type BetterAuthPlugin } from 'better-auth/types';
import { setSessionCookie } from '../utils';
import z from '@dpg/schemas';
import { sql } from 'drizzle-orm';

const BINDING_PATTERN = /^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*$/;

/**
 * Build a Postgres text[] literal "{a,b,...}" from a JS string array. Each
 * element is validated against BINDING_PATTERN so quotes, backslashes, or
 * spaces never reach the SQL parser. Used because the better-auth drizzle
 * adapter can't reliably serialise JS arrays to PG text[] columns.
 */
function buildPgTextArrayLiteral(values: string[]): string {
  const clean = values.filter((v) => typeof v === 'string' && BINDING_PATTERN.test(v));
  if (clean.length === 0) return '{}';
  // Pattern guarantees no quoting needed — emit unquoted for max
  // robustness against future Postgres versions.
  return `{${clean.join(',')}}`;
}

const CheckUserInput = z.object({
  email: z.email('Please enter a valid Email').optional().meta({
    description: 'Email to sign in. Eg: abc@org.com',
  }),
  phoneNumber: z
    .string('Please enter a valid phoneNumber with country code')
    .nonempty()
    .optional()
    .meta({
      description: 'Phone number to sign in. Eg: "+911234567890"',
    }),
  dateOfBirth: z.string().optional(),
});
const RequestOtpInput = z.object({
  email: z.email('Please enter a valid Email').optional().meta({
    description: 'Email to sign in. Eg: abc@org.com',
  }),
  phoneNumber: z
    .string('Please enter a valid phoneNumber with country code')
    .nonempty()
    .optional()
    .meta({
      description: 'Phone number to sign in. Eg: "+911234567890"',
    }),
});

const VerifyOtpInput = z.object({
  name: z.string('Please enter a valid name').nonempty().optional().meta({
    description: 'Name of the user. Eg: John Doe',
  }),
  email: z.email('Please enter a valid Email').optional().meta({
    description: 'Email to sign in. Eg: abc@org.com',
  }),
  phoneNumber: z
    .string('Please enter a valid phoneNumber with country code')
    .nonempty()
    .optional()
    .meta({
      description: 'Phone number to sign in. Eg: "+911234567890"',
    }),
  otp: z.string('Enter a valid 6 digit otp').length(6).meta({
    description: 'Six digit otp. Ex: "777666"',
  }),
  dateOfBirth: z.date().or(z.string()).optional().nullable().default(null),
  rememberMe: z
    .boolean('If session should be remembered')
    .default(true)
    .meta({
      description: 'Remember the session. Eg: true',
    })
    .optional(),
  joinOrg: z
    .object({
      orgSlug: z
        .string()
        .meta({ description: 'Slug of the organization user wants to join' }),
      role: z
        .enum(['member', 'seeker', 'viewer'])
        .optional()
        .meta({
          description: 'Role the user wants to assume in the organization',
        })
        .nullable()
        .default('viewer'),
      join: z
        .boolean()
        .default(false)
        .meta({ description: 'If user wants to join an organization' }),
    })
    .optional()
    .nullable(),
  createAdmin: z.boolean().optional().default(false).meta({
    description:
      'disables phone otp, request fails if invalid email provided, only predefined email domains allowed',
  }),
  // Network memberships chosen at signup. Each element is "network/domain",
  // e.g. ["blue_dot/seeker","purple_dot/provider"]. App-side guard enforces
  // at most one entry per network. Validated against served_domains on the
  // host (apps/api) before persistence.
  domains: z
    .array(z.string().nonempty())
    .optional()
    .meta({
      description:
        'Network/domain memberships, e.g. ["blue_dot/seeker","purple_dot/provider"]',
    }),
});

export interface UserWithPhoneNumber extends User {
  phoneNumber: string;
  phoneNumberVerified: boolean;
  dateOfBirth?: string; // stored as ISO date or YYYY-MM-DD
  termsAccepted: boolean | null;
  privacyAccepted: boolean | null;
}

export interface unifiedOtpOptions {
  /**
   * Optional callback that validates whether a (network, domain) binding is
   * served by this API instance. Used by /unified-otp/join-network to keep
   * the host's served_domains as the source of truth.
   */
  isServedBinding?: (network: string, domain: string) => boolean;
  /**
   * Drizzle db handle used by /unified-otp/join-network to write
   * user.domains as a real Postgres text[] (the better-auth drizzle
   * adapter can't reliably round-trip JS arrays). When omitted, the
   * join-network endpoint falls back to adapter.update — fine for tests,
   * unsafe for production.
   */
  db?: {
    execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
  };
  /**
   * Function to send unified otp via sms
   */
  sendPhoneOtp: (data: { phoneNumber: string; otp: string }) => Promise<void>;
  /**
   * Function to send unified otp via email
   */
  sendEmailOtp: (data: {
    email: string;
    otp: string;
    user: UserWithPhoneNumber | null;
  }) => Promise<void>;
  /**
   * Function to run after user creation. Receives the freshly created user
   * plus the network/domain memberships chosen at signup (when supplied by
   * the client). The host app persists these into user.domains.
   */
  afterUserCreate: (data: {
    user: UserWithPhoneNumber;
    domains?: string[];
  }) => Promise<Record<string, any>>;
  /**
   * email domains to be set as admin by default
   * use with caution
   */
  adminByDomain?: string[];
  createTestOtp?: boolean;
}

export const generateOtp = (is_test: boolean) => {
  return is_test
    ? '000000'
    : Math.floor(100000 + Math.random() * 900000).toString();
};
const JoinNetworkInput = z.object({
  network: z.string().nonempty(),
  domain: z.string().nonempty(),
});

export const unifiedOtp = ({
  sendPhoneOtp,
  sendEmailOtp,
  afterUserCreate,
  adminByDomain,
  createTestOtp,
  isServedBinding,
  db,
}: unifiedOtpOptions): BetterAuthPlugin => ({
  id: 'unified-otp',
  schema: {
    user: {
      fields: {
        email: { type: 'string', unique: true },
        phoneNumber: { type: 'string', required: false, unique: true },
        phoneNumberVerified: { type: 'boolean', required: false },
        dateOfBirth: { type: 'date', required: false },
        termsAccepted: { type: 'boolean', required: false },
        privacyAccepted: { type: 'boolean', required: false },
        // Network memberships ("network/domain" entries). Returned by
        // /api/auth/get-session so the UI can read them without an extra
        // /me/domains fetch.
        domains: { type: 'string[]', required: false },
      },
    },
  },

  endpoints: {
    checkUser: createAuthEndpoint(
      '/unified-otp/check-user',
      {
        method: 'POST',
        body: CheckUserInput,
        metadata: {
          openapi: {
            summary: 'Check user existence',
            description:
              'Determines whether a user exists based on the provided email or phone number. At least one of the two must be provided.',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      email: {
                        type: 'string',
                        format: 'email',
                        description: 'Email to sign in. Eg: abc@org.com',
                      },
                      phoneNumber: {
                        type: 'string',
                        description:
                          'Phone number to sign in. Eg: "+911234567890"',
                      },
                    },
                    required: ['otp', 'phoneNumber'],
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'OTP successfully sent',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        userExists: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
              '400': {
                description: 'Invalid input or missing email/phoneNumber',
              },
            },
          },
        },
      },
      async (ctx) => {
        const validator = CheckUserInput.safeParse(ctx.body);

        if (!validator.success) {
          throw new APIError('BAD_REQUEST', {
            message: 'Validation failed',
            issues: validator.error.issues,
          });
        }

        const { email, phoneNumber } = validator.data;

        let user: UserWithPhoneNumber | null = null;

        if (email) {
          user = await ctx.context.adapter.findOne<UserWithPhoneNumber>({
            model: 'user',
            where: [{ field: 'email', value: email }],
          });
        }
        if (!user && phoneNumber) {
          user = await ctx.context.adapter.findOne<UserWithPhoneNumber>({
            model: 'user',
            where: [{ field: 'phoneNumber', value: phoneNumber }],
          });
        }
        if (user) {
          return ctx.json({ userExists: true });
        } else {
          return ctx.json({ userExists: false });
        }
      }
    ),

    requestOtp: createAuthEndpoint(
      '/unified-otp/request',
      {
        method: 'POST',
        body: RequestOtpInput,
        metadata: {
          openapi: {
            summary: 'Request OTP',
            description:
              'Request a one-time password (OTP) to be sent to either an email or phone number for authentication.',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      email: {
                        type: 'string',
                        format: 'email',
                        description: 'Email to sign in. Eg: abc@org.com',
                      },
                      phoneNumber: {
                        type: 'string',
                        description:
                          'Phone number to sign in. Eg: "+911234567890"',
                      },
                      name: {
                        type: 'string',
                        description: 'Name of the user. Eg: John Doe',
                      },
                    },
                    required: ['phoneNumber'],
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'OTP successfully sent',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        ok: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
              '400': {
                description: 'Invalid input or missing email/phoneNumber',
              },
            },
          },
        },
      },
      async (ctx) => {
        const validator = RequestOtpInput.safeParse(ctx.body);

        if (!validator.success) {
          throw new APIError('BAD_REQUEST', {
            message: 'Validation failed',
            issues: validator.error.issues,
          });
        }

        const { email, phoneNumber } = validator.data;

        let user: UserWithPhoneNumber | null = null;

        if (email) {
          user = await ctx.context.adapter.findOne<UserWithPhoneNumber>({
            model: 'user',
            where: [{ field: 'email', value: email }],
          });
        }
        if (!user && phoneNumber) {
          user = await ctx.context.adapter.findOne<UserWithPhoneNumber>({
            model: 'user',
            where: [{ field: 'phoneNumber', value: phoneNumber }],
          });
        }
        if (user) {
          if (email && user.email && user.email.trim() !== '') {
            if (user.email !== email) {
              throw new APIError('BAD_REQUEST', {
                message:
                  'Provided email does not match the user’s registered email.',
              });
            }
          }

          if (
            phoneNumber &&
            user.phoneNumber &&
            user.phoneNumber.trim() !== ''
          ) {
            if (user.phoneNumber !== phoneNumber) {
              throw new APIError('BAD_REQUEST', {
                message:
                  'Provided phone number does not match the user’s registered phone number.',
              });
            }
          }
        }

        const otp = generateOtp(createTestOtp || false);
        const expiresInSec = 5 * 60; // 5 mins

        const key = phoneNumber
          ? `otp:phone:${phoneNumber}`
          : `otp:email:${email}`;

        await ctx.context.secondaryStorage?.set(key, otp, expiresInSec);

        if (phoneNumber) {
          await sendPhoneOtp({
            phoneNumber,
            otp,
          });
        }

        if (email) {
          sendEmailOtp({ email, otp, user });
        }

        return ctx.json({ ok: true, user: user ? true : false });
      }
    ),

    verifyOtp: createAuthEndpoint(
      '/unified-otp/verify',
      {
        method: 'POST',
        body: VerifyOtpInput,
        metadata: {
          openapi: {
            summary: 'Verify OTP',
            description:
              'Verify the one-time password (OTP) sent to email or phone number and log the user in.',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      email: {
                        type: 'string',
                        format: 'email',
                        description: 'Email to sign in. Eg: abc@org.com',
                      },
                      phoneNumber: {
                        type: 'string',
                        description:
                          'Phone number to sign in. Eg: "+911234567890"',
                      },
                      otp: {
                        type: 'string',
                        minLength: 6,
                        maxLength: 6,
                        description: 'Six digit OTP. Ex: "777666"',
                      },
                      rememberMe: {
                        type: 'boolean',
                        default: false,
                        description: 'Remember the session. Eg: true',
                      },
                    },
                    required: ['otp', 'phoneNumber'],
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'OTP verified and session created',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        redirect: { type: 'string' },
                        token: { type: 'string' },
                        user: {
                          type: 'object',
                          properties: {
                            id: {
                              type: 'string',
                              example: 'ccGNAimGHt3y2BhtBzKNAA9IZn7Ny342',
                            },
                            name: {
                              type: 'string',
                              example: 'John Doe',
                            },
                            email: {
                              type: 'string',
                              format: 'email',
                              example: 'john.dow@abc.com',
                            },
                            emailVerified: {
                              type: 'boolean',
                              example: true,
                            },
                            phoneNumber: {
                              type: 'string',
                              example: '+919999999990',
                            },
                            phoneNumberVerified: {
                              type: 'boolean',
                              example: true,
                            },
                            image: {
                              type: 'string',
                              example: '',
                            },
                            role: {
                              type: 'string',
                              enum: ['admin', 'user', 'moderator'],
                              example: 'admin',
                            },
                            banned: {
                              type: 'boolean',
                              example: false,
                            },
                            banReason: {
                              type: 'string',
                              nullable: true,
                              example: '',
                            },
                            banExpires: {
                              type: 'string',
                              format: 'date-time',
                              nullable: true,
                              example: null,
                            },
                            createdAt: {
                              type: 'string',
                              format: 'date-time',
                              example: '2025-07-28T14:58:13.768Z',
                            },
                            updatedAt: {
                              type: 'string',
                              format: 'date-time',
                              example: '2025-07-28T14:58:13.768Z',
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              '400': {
                description: 'Invalid OTP, expired, or user not found',
              },
              '503': {
                description: 'Service unavailable',
              },
            },
          },
        },
      },

      async (ctx) => {
        const validator = VerifyOtpInput.safeParse(ctx.body);

        if (!validator.success) {
          throw new APIError('BAD_REQUEST', {
            message: 'Validation failed',
            issues: validator.error.issues,
          });
        }

        const {
          name,
          email,
          phoneNumber,
          otp,
          rememberMe,
          joinOrg,
          createAdmin,
          dateOfBirth,
          domains,
        } = validator.data;

        if (!email && !phoneNumber) {
          throw new APIError('BAD_REQUEST', {
            message: 'Enter either phone number or email',
          });
        }

        const redis = ctx.context.secondaryStorage;
        let otpKey: string | null = null;

        if (phoneNumber) {
          const phoneKey = `otp:phone:${phoneNumber}`;
          const expectedOtp = await redis?.get(phoneKey);
          if (expectedOtp === otp) {
            otpKey = phoneKey;
          }
        }

        if (!otpKey && email) {
          const emailKey = `otp:email:${email}`;
          const expectedOtp = await redis?.get(emailKey);
          if (expectedOtp === otp) {
            otpKey = emailKey;
          }
        }

        if (!otpKey) {
          throw new APIError('BAD_REQUEST', {
            message: 'Invalid or expired OTP.',
          });
        }

        await redis?.delete(otpKey);

        let user: UserWithPhoneNumber | null = null;

        if (phoneNumber) {
          user = await ctx.context.adapter.findOne<UserWithPhoneNumber>({
            model: 'user',
            where: [{ field: 'phoneNumber', value: phoneNumber }],
          });
        }

        if (!user && email) {
          user = await ctx.context.adapter.findOne<UserWithPhoneNumber>({
            model: 'user',
            where: [{ field: 'email', value: email }],
          });
        }

        let isNewUser = false;

        if (!user) {
          isNewUser = true;
          let domain: string | undefined,
            isAdmin = false;
          if (createAdmin && Array.isArray(adminByDomain)) {
            const splitEmail = email?.split('@');

            Array.isArray(splitEmail) && (domain = splitEmail[1]);
            if (typeof domain === 'string') {
              adminByDomain.includes(domain) && (isAdmin = true);
            } else {
              throw new APIError('BAD_REQUEST', {
                message: 'Provided email address can not be an admin.',
              });
            }
          }

          const dob: Date | null =
            typeof dateOfBirth === 'string' ? new Date(dateOfBirth) : null;

          user = await ctx.context.adapter.create({
            model: 'user',
            data: {
              email: email || null,
              phoneNumber: phoneNumber || null,
              name: name || 'user',
              email_verified: false,
              phoneNumberVerified: false,
              role: isAdmin ? 'admin' : 'user',
              image: '',
              banned: false,
              banReason: '',
              banExpires: null,
              dateOfBirth: dob,
              termsAccepted: true,
              privacyAccepted: true,
            },
          });
        }

        if (!user)
          throw new APIError('INTERNAL_SERVER_ERROR', {
            message: 'User not found',
          });

        if (
          email &&
          user.email &&
          user.email.trim() !== '' &&
          user.email !== email
        ) {
          throw new APIError('BAD_REQUEST', {
            message:
              'Provided email does not match the user’s registered email.',
          });
        }

        if (
          phoneNumber &&
          user.phoneNumber &&
          user.phoneNumber.trim() !== '' &&
          user.phoneNumber !== phoneNumber
        ) {
          throw new APIError('BAD_REQUEST', {
            message:
              'Provided phone number does not match the user’s registered phone number.',
          });
        }

        if (joinOrg?.join) {
          const orgSlug = joinOrg.orgSlug;
          const role = joinOrg.role ?? 'member';

          if (!orgSlug) {
            throw new APIError('BAD_REQUEST', {
              message: 'Organization slug is required to join an organization.',
            });
          }

          // Search for organization by slug
          const organization: any = await ctx.context.adapter.findOne({
            model: 'organization',
            where: [{ field: 'slug', value: orgSlug }],
          });

          if (!organization) {
            throw new APIError('NOT_FOUND', {
              message: 'Organization not found.',
            });
          }

          const isAlreadyMember = await ctx.context.adapter.findOne({
            model: 'member',
            where: [
              { field: 'organizationId', value: organization.id },
              { field: 'userId', value: user.id },
            ],
          });

          if (!isAlreadyMember) {
            try {
              await ctx.context.adapter.create({
                model: 'member',
                data: {
                  organizationId: organization.id,
                  userId: user.id,
                  role,
                  teamId: null,
                  createdAt: new Date(),
                },
              });
            } catch (err) {
              console.log('failed creation of a member: ', err);
            }
          }
        }

        const updates: Partial<UserWithPhoneNumber> = {};

        if (email) {
          if (!user.email || user.email.trim() === '') {
            updates.email = email;
          }
          if (!user.emailVerified) {
            updates.emailVerified = true;
          }
        }

        if (phoneNumber) {
          if (!user.phoneNumber || user.phoneNumber.trim() === '') {
            updates.phoneNumber = phoneNumber;
          }
          if (!user.phoneNumberVerified) {
            updates.phoneNumberVerified = true;
          }
        }

        if (Object.keys(updates).length > 0) {
          await ctx.context.adapter.update<UserWithPhoneNumber>({
            model: 'user',
            where: [{ field: 'id', value: user.id }],
            update: updates,
          });
        }

        // Membership persistence happens inside afterUserCreate (host owns
        // the raw drizzle handle and the user.domains column). Run BEFORE
        // the final user re-read so the response + cookie cache include
        // the newly-written domains.
        const afterUser = isNewUser
          ? await afterUserCreate({ user, domains })
          : null;

        const updatedUser =
          await ctx.context.adapter.findOne<UserWithPhoneNumber>({
            model: 'user',
            where: [{ field: 'id', value: user.id }],
          });

        if (!updatedUser) {
          throw new APIError('SERVICE_UNAVAILABLE');
        }

        try {
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            rememberMe === false
          );

          await setSessionCookie(
            ctx,
            {
              session: session as any,
              user: { ...updatedUser },
            },
            rememberMe === false
          );

          return {
            redirect: false,
            token: session.token,
            user: { ...updatedUser },
            ...(afterUser ? { afterUserCreate: afterUser } : {}),
          };
        } catch (error: any) {
          throw new APIError('SERVICE_UNAVAILABLE', error.message);
        }
      }
    ),

    joinNetwork: createAuthEndpoint(
      '/unified-otp/join-network',
      {
        method: 'POST',
        body: JoinNetworkInput,
        use: [sessionMiddleware],
        metadata: {
          openapi: {
            summary: 'Join a (network, domain)',
            description:
              'Appends "network/domain" to the authenticated user\'s domains[]. Idempotent if the user already holds the same binding; 409 if they already hold a different domain in this network.',
          },
        },
      },
      async (ctx) => {
        const validator = JoinNetworkInput.safeParse(ctx.body);
        if (!validator.success) {
          throw new APIError('BAD_REQUEST', {
            message: 'Validation failed',
            issues: validator.error.issues,
          });
        }

        const { network, domain } = validator.data;
        const binding = `${network}/${domain}`;

        if (isServedBinding && !isServedBinding(network, domain)) {
          throw new APIError('FORBIDDEN', {
            message: `network/domain "${binding}" is not served by this instance`,
          });
        }

        const userId = ctx.context.session.user.id;

        // Read current domains so we can enforce "one domain per network"
        // and idempotency before writing.
        const current =
          (ctx.context.session.user as unknown as { domains?: string[] })
            .domains ?? [];
        const networkPrefix = `${network}/`;
        const matched = current.find((d: string) =>
          d.startsWith(networkPrefix),
        );

        if (matched === binding) {
          return ctx.json({ network, domain, created: false });
        }
        if (matched) {
          const registeredDomain = matched.slice(networkPrefix.length);
          throw new APIError('CONFLICT', {
            message: `user is already registered as "${registeredDomain}" in "${network}"`,
          });
        }

        // Re-read user.domains from the DB before computing the new array
        // — the session cookie cache (configured in createAuth) can be up
        // to 10 minutes stale, so trusting session.user.domains here can
        // wipe a binding that already exists.
        const fresh = (await ctx.context.adapter.findOne<{
          id: string;
          domains?: string[];
        }>({
          model: 'user',
          where: [{ field: 'id', value: userId }],
        })) as { id: string; domains?: string[] } | null;

        const freshDomains = fresh?.domains ?? [];
        const freshMatched = freshDomains.find((d: string) =>
          d.startsWith(networkPrefix),
        );

        // Helper — refresh cookie cache with the freshest row so a
        // /get-session right after this endpoint reflects the up-to-date
        // domains (cookieCache.maxAge is ~10 min otherwise).
        const refreshCookie = async (rowForCookie: unknown) => {
          await setSessionCookie(ctx, {
            session: ctx.context.session.session as any,
            user: {
              ...ctx.context.session.user,
              ...((rowForCookie as object) ?? {}),
            } as any,
          });
        };

        if (freshMatched === binding) {
          // Idempotent fast-path. Still refresh the cookie — the stale
          // session might be lacking this very binding even though the
          // DB has it (e.g. when the user just joined via another tab).
          await refreshCookie(fresh);
          return ctx.json({ network, domain, created: false });
        }
        if (freshMatched) {
          const registeredDomain = freshMatched.slice(networkPrefix.length);
          throw new APIError('CONFLICT', {
            message: `user is already registered as "${registeredDomain}" in "${network}"`,
          });
        }

        const next = Array.from(new Set([...freshDomains, binding]));

        // Write the array as a real Postgres text[] literal — the
        // better-auth drizzle adapter can serialise JS arrays as JSON
        // strings under some configurations, which would corrupt the
        // column. The buildPgTextArrayLiteral helper validates each
        // element against BINDING_PATTERN so no shell/SQL meta-chars can
        // leak into the literal.
        if (db) {
          const literal = buildPgTextArrayLiteral(next);
          try {
            await db.execute(sql`
              UPDATE "user"
              SET domains = ${literal}::text[]
              WHERE id = ${userId}
            `);
          } catch (err) {
            throw new APIError('INTERNAL_SERVER_ERROR', {
              message: 'failed to write user.domains',
              cause: err as Error,
            });
          }
        } else {
          // Fallback for tests that don't pass a db handle.
          await ctx.context.adapter.update({
            model: 'user',
            where: [{ field: 'id', value: userId }],
            update: { domains: next },
          });
        }

        // Refresh cookie cache — otherwise /get-session returns the
        // pre-join user object for up to cookieCache.maxAge seconds.
        const updated = await ctx.context.adapter.findOne({
          model: 'user',
          where: [{ field: 'id', value: userId }],
        });
        await refreshCookie(updated);

        return ctx.json({ network, domain, created: true });
      },
    ),
  },
});

