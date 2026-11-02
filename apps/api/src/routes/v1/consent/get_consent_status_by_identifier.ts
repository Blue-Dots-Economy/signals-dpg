import {
  ConsentStatusByIdentifierQuerySchema,
  ConsentStatusByIdentifierResponseSchema,
} from '@dpg/schemas';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import { user } from '@api/db/postgres/schema/auth';
import { incrWithinWindow } from '@/utils/rate_window';

type Req = FastifyRequest<{
  Querystring: { network: string; phone?: string; email?: string };
}>;

const EMPTY_STATUSES = { statuses: { terms: [] as number[], privacy: [] as number[] } };

// Unauthenticated by design (pre-login consent check), so the response reveals
// whether a user exists. A per-IP fixed window blunts bulk enumeration.
// Fail-open on a Redis blip, so a limiter outage cannot break login.
//
// No `variant` in this response, unlike the authenticated `/consent/status`:
// it would tell anyone holding a phone number that it belongs to a minor, and
// the per-IP window does nothing against a targeted lookup. The pre-login gate
// therefore shows the adult copy; a gated minor is routed to `U18GuardianFlow`
// after authentication (`oidc-callback-page.tsx`), and the UI does not record
// a pre-login acceptance for a known minor on a network with a U18 set
// (`pre-login-consent.ts`).
//
// Keyed on `request.ip`, which comes from X-Forwarded-For via `trustProxy`, so
// it is only as trustworthy as the edge. An edge per-route limit (e.g. Kong,
// limit_by: ip) sees the real socket IP; this app-level limit is the portable
// control, and the only one on a bare install. Both stack.
const CONSENT_RL_WINDOW_SEC = 60;
const CONSENT_RL_MAX_PER_WINDOW = 30;

export const get_consent_status_by_identifier: FastifyPluginAsyncZod = (fastify) => {
  fastify.route({
    url: '/status-by-identifier',
    method: 'GET',
    schema: {
      tags: ['consent'],
      querystring: ConsentStatusByIdentifierQuerySchema,
      response: {
        200: ConsentStatusByIdentifierResponseSchema,
      },
    },
    handler: get_consent_status_by_identifier_handler,
  });
  // Plugins return a promise; nothing here awaits (the route registers synchronously).
  return Promise.resolve();
};

export const get_consent_status_by_identifier_handler = async (
  request: Req,
  reply: FastifyReply,
) => {
  const { network, phone, email } = request.query;

  try {
    const rlCount = await incrWithinWindow(
      `consent:status:rl:${request.ip}`,
      CONSENT_RL_WINDOW_SEC,
    );
    if (rlCount > CONSENT_RL_MAX_PER_WINDOW) {
      return reply.code(429).send({
        error: 'CONSENT_RATE_LIMITED',
        message: 'Too many requests; please try again later.',
      });
    }
  } catch (err) {
    request.log.warn(
      { err },
      'consent status-by-identifier rate-limit check unavailable; allowing request',
    );
  }

  try {
    // A missing user is not an error: a new user simply needs consent.
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
