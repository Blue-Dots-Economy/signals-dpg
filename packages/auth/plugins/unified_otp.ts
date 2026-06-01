import { type User } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { type BetterAuthPlugin } from 'better-auth/types';
import { setSessionCookie } from '../utils';
import z from '@dpg/schemas';

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
  // Network membership: when a new user signs up, record which (network,
  // domain) they joined under. Both are required together; passing only
  // one is ignored. Validated against the API's served domain bindings on
  // the server side before insertion.
  network: z
    .string()
    .nonempty()
    .optional()
    .meta({
      description: 'Network id the new user is joining. Eg: "purple_dot"',
    }),
  domain: z
    .string()
    .nonempty()
    .optional()
    .meta({
      description: 'Domain id within the network. Eg: "seeker"',
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
   * plus the (network, domain) the signup happened under (when supplied by
   * the client). The host app uses this to persist the user_network
   * membership row.
   */
  afterUserCreate: (data: {
    user: UserWithPhoneNumber;
    network?: string;
    domain?: string;
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
export const unifiedOtp = ({
  sendPhoneOtp,
  sendEmailOtp,
  afterUserCreate,
  adminByDomain,
  createTestOtp,
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
      },
    },
    userNetwork: {
      modelName: 'user_network',
      fields: {
        userId: {
          type: 'string',
          required: true,
          references: {
            model: 'user',
            field: 'id',
            onDelete: 'cascade',
          },
        },
        network: { type: 'string', required: true },
        domain: { type: 'string', required: true },
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
          network,
          domain,
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

        const updatedUser =
          await ctx.context.adapter.findOne<UserWithPhoneNumber>({
            model: 'user',
            where: [{ field: 'id', value: user.id }],
          });

        if (!updatedUser) {
          throw new APIError('SERVICE_UNAVAILABLE');
        }

        // Persist (user, network, domain) membership for fresh users when
        // the client supplied them. PK on (user_id, network) deduplicates;
        // we log and swallow other errors so signup never fails on the
        // bridge insert.
        if (isNewUser && network && domain) {
          try {
            await ctx.context.adapter.create({
              model: 'userNetwork',
              data: {
                userId: user.id,
                network,
                domain,
              },
            });
          } catch (err) {
            console.error('Failed to record user_network membership:', err);
          }
        }

        const afterUser = isNewUser
          ? await afterUserCreate({ user, network, domain })
          : null;

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
  },
});
