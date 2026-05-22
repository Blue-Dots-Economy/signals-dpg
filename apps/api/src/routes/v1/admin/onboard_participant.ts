import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq, or } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '../../../../db/postgres/schema/auth.js';
import { authInstance } from '@/routes/auth/create_auth';
import { create_profile_item } from '@/lib/profile_item';
import {
  OnboardParticipantRequest,
  OnboardParticipantResponse,
  type OnboardParticipantRequest as OnboardParticipantBody,
} from '@dpg/schemas';

/**
 * POST /api/v1/admin/onboard_participant
 *
 * Plan 2 Task 5. Creates a participant on Signals: a new user plus their
 * profile_1.0 item, with an attribution record of where the onboarding
 * originated.
 *
 * Auth + acting_org resolution happens upstream in admin_routes' preHandler
 * chain. This handler narrows the permitted acting_org.org_type to
 * 'aggregator' or 'voice' — the network_service caller (used by the
 * aggregator-upsert mirror) is rejected here; participant onboarding must
 * be asserted on behalf of a real aggregator/voice org.
 */
type OnboardRequest = FastifyRequest<{ Body: OnboardParticipantBody }>;

export const onboard_participant: FastifyPluginAsync = async (app) => {
  app.route({
    url: '/onboard_participant',
    method: 'POST',
    schema: {
      body: OnboardParticipantRequest,
      response: { 200: OnboardParticipantResponse },
    },
    handler: onboard_participant_handler,
  });
};

export const onboard_participant_handler = async (
  request: OnboardRequest,
  reply: FastifyReply,
) => {
  const acting = request.acting_org;
  if (
    !acting ||
    (acting.org_type !== 'aggregator' && acting.org_type !== 'voice')
  ) {
    return reply.code(403).send({
      error: 'INVALID_ACTING_ORG',
      message:
        'onboarding must be asserted on behalf of an aggregator or voice org',
    });
  }

  const body = request.body;
  const email_norm = body.email?.trim().toLowerCase() ?? null;
  const phone_norm = body.phone_number?.trim() ?? null;

  // Defensive — schema refine should have caught this.
  if (!email_norm && !phone_norm) {
    return reply.code(400).send({
      error: 'MISSING_IDENTIFIER',
      message: 'either email or phone_number is required',
    });
  }

  // Pre-check uniqueness on the user table.
  const conditions = [];
  if (email_norm) conditions.push(eq(user.email, email_norm));
  if (phone_norm) conditions.push(eq(user.phoneNumber, phone_norm));
  const whereClause =
    conditions.length === 1 ? conditions[0] : or(...conditions);

  const conflictRows = await db
    .select({
      id: user.id,
      email: user.email,
      phoneNumber: user.phoneNumber,
    })
    .from(user)
    .where(whereClause!)
    .limit(1);

  if (conflictRows[0]) {
    const conflict = conflictRows[0];
    const which =
      email_norm && conflict.email === email_norm ? 'email' : 'phone_number';
    return reply.code(409).send({
      error: 'USER_ALREADY_EXISTS',
      message: `a user with this ${which} already exists`,
    });
  }

  try {
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const email_for_signup =
        email_norm ?? `${randomUUID()}@no-email.local`;
      const signed_up = await authInstance.api.signUpEmail({
        body: {
          email: email_for_signup,
          password: randomUUID(),
          name: body.name,
        },
      });
      const user_id = signed_up.user.id;

      await tx
        .update(user)
        .set({
          phoneNumber: phone_norm,
          phoneNumberVerified: false,
          dateOfBirth: body.date_of_birth ? new Date(body.date_of_birth) : null,
          termsAccepted: true,
          privacyAccepted: true,
          onboardedByOrgId: acting.org_id,
          onboardedVia: body.channel,
          onboardedSourceId: body.source_id ?? null,
          onboardedAt: now,
          updatedAt: now,
        })
        .where(eq(user.id, user_id));

      const { item_id } = await create_profile_item({
        tx,
        user_id,
        network: body.network ?? 'blue_dot',
        domain: body.domain ?? 'seeker',
        item_type: body.item_type ?? 'profile_1.0',
        payload: body.profile,
      });

      return {
        user_id,
        profile_item_id: item_id,
        onboarded_at: now.toISOString(),
      };
    });

    return result;
  } catch (err: unknown) {
    const e = err as {
      code?: string;
      message?: string;
      cause?: { code?: string };
      statusCode?: number;
      errorCode?: string;
    } | null;
    const pg_code = e?.code ?? e?.cause?.code;
    const message = String(e?.message ?? '');

    // Pre-known typed errors from item_service / other domain layers carry
    // their own statusCode + errorCode — surface them faithfully rather than
    // swallowing into ONBOARD_FAILED. ItemServiceError in
    // apps/api/src/services/item_service.ts exposes exactly these two
    // fields (statusCode, errorCode) on the Error subclass.
    if (e?.statusCode && e?.errorCode) {
      request.log.error(
        { err, errorCode: e.errorCode },
        'onboard_participant rejected by downstream',
      );
      return reply.code(e.statusCode).send({
        error: e.errorCode,
        message: e.message ?? 'request rejected',
      });
    }

    if (
      pg_code === '23505' ||
      message.includes('duplicate key value') ||
      message.includes('unique constraint')
    ) {
      request.log.error({ err }, 'unique conflict during onboarding');
      return reply.code(409).send({
        error: 'USER_ALREADY_EXISTS',
        message: 'email or phone already in use (race)',
      });
    }
    request.log.error({ err }, 'onboard_participant failed');
    return reply.code(500).send({
      error: 'ONBOARD_FAILED',
      message: 'could not onboard participant',
    });
  }
};

export default onboard_participant;
