import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import z from '@dpg/schemas';
import { DrizzleQueryError, eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user as userTable } from '@api/db/postgres/schema/auth';
import { items, ensureItemPartition, DatabaseError } from '@dpg/database';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import {
  createItemInternal,
  ItemServiceError,
  updateItemInternal,
} from '@/services/item_service';

const OnboardUserSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().email().optional(),
    phoneNumber: z.string().min(5).optional(),
  })
  .refine((d) => Boolean(d.email || d.phoneNumber), {
    message: 'Either email or phoneNumber is required',
    path: ['email'],
  });

const OnboardProfileSchema = z
  .object({
    item_id: z.string().uuid().optional(),
    item_network: z.string().min(1),
    item_domain: z.string().min(1),
    item_type: z.string().min(1),
    item_state: z.record(z.string(), z.unknown()).optional(),
    item_latitude: z.number().nullable().optional(),
    item_longitude: z.number().nullable().optional(),
  })
  .strict();

export const OnboardBodySchema = z.object({
  user: OnboardUserSchema,
  profile: OnboardProfileSchema.optional(),
  lookup_only: z.boolean().optional().default(false),
});

type OnboardRequest = FastifyRequest<{
  Body: z.infer<typeof OnboardBodySchema>;
}>;

class OnboardError extends Error {
  statusCode: number;
  errorCode: string;
  constructor(statusCode: number, errorCode: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

export const onboard: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    method: 'POST',
    url: '/onboard',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['admin'],
      body: OnboardBodySchema,
    },
    handler: onboard_handler,
  });
};

export const onboard_handler = async (
  request: OnboardRequest,
  reply: FastifyReply
) => {
  if (request.user?.role !== 'admin') {
    return reply.code(403).send({
      error: 'FORBIDDEN',
      message: 'Admin role required',
    });
  }

  const {
    user: userInput,
    profile: profileInput,
    lookup_only: lookupOnly,
  } = request.body;
  const normalizedEmail = userInput.email?.trim().toLowerCase() || null;
  const normalizedPhone = userInput.phoneNumber?.trim() || null;

  if (!normalizedEmail && !normalizedPhone) {
    return reply.code(400).send({
      error: 'MISSING_IDENTIFIER',
      message: 'Either email or phoneNumber is required',
    });
  }

  if (lookupOnly) {
    try {
      const emailUser = normalizedEmail ? (
        await db.select().from(userTable).where(eq(userTable.email, normalizedEmail)).limit(1))[0] : undefined;
      const phoneUser = normalizedPhone ? (
        await db.select().from(userTable).where(eq(userTable.phoneNumber, normalizedPhone)).limit(1))[0] : undefined;
      if (emailUser && phoneUser && emailUser.id !== phoneUser.id) {
        return reply.code(409).send({
          error: 'USER_CONFLICT',
          message: 'email and phoneNumber map to different existing users',
        });
      }
      const userRow = emailUser ?? phoneUser ?? null;
      if (!userRow) {
        return reply.code(200).send({ exists: false, user: null });
      }
      return reply.code(200).send({
        exists: true,
        user: {
          id: userRow.id,
          name: userRow.name,
          email: userRow.email,
          phoneNumber: userRow.phoneNumber,
          role: userRow.role,
        },
      });
    } catch (err) {
      request.log.error({ err }, 'Onboard lookup failed');
      return reply.code(500).send({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Lookup failed',
      });
    }
  }

  if (profileInput && !profileInput.item_id) {
    try {
      await ensureItemPartition(
        db,
        profileInput.item_network,
        profileInput.item_domain
      );
    } catch (err) {
      request.log.error(
        {
          err,
          item_network: profileInput.item_network,
          item_domain: profileInput.item_domain,
        },
        'Failed to ensure item partition'
      );
      return reply.code(500).send({
        error: 'PARTITION_SETUP_FAILED',
        message: 'Failed to prepare storage for item type',
      });
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      const emailUser = normalizedEmail
        ? (
          await tx
            .select()
            .from(userTable)
            .where(eq(userTable.email, normalizedEmail))
            .limit(1)
        )[0]
        : undefined;

      const phoneUser = normalizedPhone
        ? (
          await tx
            .select()
            .from(userTable)
            .where(eq(userTable.phoneNumber, normalizedPhone))
            .limit(1)
        )[0]
        : undefined;

      if (emailUser && phoneUser && emailUser.id !== phoneUser.id) {
        throw new OnboardError(
          409,
          'USER_CONFLICT',
          'email and phoneNumber map to different existing users'
        );
      }

      let userRow = emailUser ?? phoneUser;
      let userCreated = false;
      let userExisted = Boolean(userRow);

      if (!userRow) {
        if (profileInput?.item_id) {
          throw new OnboardError(
            400,
            'PROFILE_UPDATE_REQUIRES_USER',
            'item_id provided but user does not exist'
          );
        }

        const [created] = await tx
          .insert(userTable)
          .values({
            id: randomUUID(),
            name: userInput.name,
            email: normalizedEmail,
            emailVerified: false,
            phoneNumber: normalizedPhone,
            phoneNumberVerified: false,
            role: 'user',
            image: '',
            termsAccepted: true,
            privacyAccepted: true,
          })
          .returning();
        userRow = created;
        userCreated = true;
      }

      let profileCreated = false;
      let profileUpdated = false;

      if (profileInput) {
        if (profileInput.item_id) {
          const [existingProfile] = await tx
            .select({
              item_id: items.item_id,
              created_by: items.created_by,
            })
            .from(items)
            .where(eq(items.item_id, profileInput.item_id))
            .limit(1);

          if (!existingProfile) {
            throw new OnboardError(
              404,
              'PROFILE_NOT_FOUND',
              'Profile with given item_id not found'
            );
          }

          if (existingProfile.created_by !== userRow.id) {
            throw new OnboardError(
              403,
              'PROFILE_OWNERSHIP_MISMATCH',
              'item_id belongs to a different user'
            );
          }

          await updateItemInternal(
            tx,
            profileInput.item_id,
            userRow.id,
            true,
            {
              item_state: profileInput.item_state,
              item_latitude: profileInput.item_latitude ?? null,
              item_longitude: profileInput.item_longitude ?? null,
            }
          );
          profileUpdated = true;
        } else {
          await createItemInternal(tx, {
            item_network: profileInput.item_network,
            item_domain: profileInput.item_domain,
            item_type: profileInput.item_type,
            item_state: profileInput.item_state ?? {},
            item_latitude: profileInput.item_latitude ?? null,
            item_longitude: profileInput.item_longitude ?? null,
            created_by: userRow.id,
          });
          profileCreated = true;
        }
      }

      const profileRows = await tx
        .select({
          item_id: items.item_id,
          item_network: items.item_network,
          item_domain: items.item_domain,
          item_type: items.item_type,
          item_state: items.item_state,
          item_latitude: items.item_latitude,
          item_longitude: items.item_longitude,
          created_at: items.created_at,
          updated_at: items.updated_at,
        })
        .from(items)
        .where(eq(items.created_by, userRow.id));

      return {
        user: {
          id: userRow.id,
          name: userRow.name,
          email: userRow.email,
          phoneNumber: userRow.phoneNumber,
          role: userRow.role,
        },
        profiles: profileRows,
        status: {
          userCreated,
          userExisted,
          profileCreated,
          profileUpdated,
          profileExisted: Boolean(
            profileInput && !profileCreated && !profileUpdated
          ),
        },
      };
    });

    return reply.code(200).send(result);
  } catch (err) {
    if (err instanceof OnboardError) {
      return reply.code(err.statusCode).send({
        error: err.errorCode,
        message: err.message,
      });
    }
    if (err instanceof ItemServiceError) {
      return reply.code(err.statusCode).send({
        error: err.errorCode,
        message: err.message,
      });
    }
    if (err instanceof DrizzleQueryError) {
      const cause = err.cause;
      if (cause instanceof DatabaseError) {
        if (cause.code === '23505') {
          return reply.code(409).send({
            error: 'USER_CONFLICT',
            message: 'A user with the same email or phone number already exists',
          });
        }
        if (cause.code === '23503') {
          return reply.code(400).send({
            error: 'INVALID_REFERENCE',
            message: 'Referenced entity does not exist',
          });
        }
      }
    }
    request.log.error({ err }, 'Onboard failed');
    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Onboarding failed',
    });
  }
};
