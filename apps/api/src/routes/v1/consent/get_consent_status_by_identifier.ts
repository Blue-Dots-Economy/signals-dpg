import {
  ConsentStatusByIdentifierQuerySchema,
  ConsentStatusResponseSchema,
} from '@dpg/schemas';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import { user } from '@api/db/postgres/schema/auth';

type Req = FastifyRequest<{
  Querystring: { network: string; phone?: string; email?: string };
}>;

const EMPTY_STATUSES = { statuses: { terms: [] as number[], privacy: [] as number[] } };

export const get_consent_status_by_identifier: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/status-by-identifier',
    method: 'GET',
    schema: {
      tags: ['consent'],
      querystring: ConsentStatusByIdentifierQuerySchema,
      response: {
        200: ConsentStatusResponseSchema,
      },
    },
    handler: get_consent_status_by_identifier_handler,
  });
};

export const get_consent_status_by_identifier_handler = async (
  request: Req,
  reply: FastifyReply,
) => {
  const { network, phone, email } = request.query;

  try {
    // Resolve the user from the identifier — no auth required (pre-login).
    // A missing user is not an error: it just means a new user who needs consent.
    const identifierConditions: SQL[] = [];
    if (email) identifierConditions.push(eq(user.email, email));
    if (phone) identifierConditions.push(eq(user.phoneNumber, phone));

    if (identifierConditions.length === 0) {
      return reply.code(200).send(EMPTY_STATUSES);
    }

    const userRows = await db
      .select({ id: user.id })
      .from(user)
      .where(or(...identifierConditions))
      .limit(1);

    if (userRows.length === 0) {
      return reply.code(200).send(EMPTY_STATUSES);
    }

    const userId = userRows[0].id;

    const rows = await db
      .select({
        consentCategory: consent_record.consentCategory,
        documentVersion: consent_record.documentVersion,
      })
      .from(consent_record)
      .where(
        and(
          eq(consent_record.userId, userId),
          eq(consent_record.level, 'user'),
          eq(consent_record.network, network),
          inArray(consent_record.consentCategory, ['terms', 'privacy']),
        ),
      );

    const termsSet = new Set<number>();
    const privacySet = new Set<number>();

    for (const row of rows) {
      if (row.consentCategory === 'terms') {
        termsSet.add(row.documentVersion);
      } else if (row.consentCategory === 'privacy') {
        privacySet.add(row.documentVersion);
      }
    }

    return reply.code(200).send({
      statuses: {
        terms: Array.from(termsSet).sort((a, b) => a - b),
        privacy: Array.from(privacySet).sort((a, b) => a - b),
      },
    });
  } catch (err) {
    request.log.error({ err }, 'consent status-by-identifier read failed');
    return reply.code(500).send({
      error: 'CONSENT_READ_FAILED',
      message: 'Failed to read consent status.',
    });
  }
};
