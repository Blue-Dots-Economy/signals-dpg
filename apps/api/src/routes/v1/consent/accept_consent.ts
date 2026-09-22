import {
  ConsentAcceptBodySchema,
  ConsentAcceptResponseSchema,
  type ConsentAcceptBody,
} from '@dpg/schemas';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { resolveConsentVersion } from '@/services/consent_version';
import { resolveUserConsentVariant } from '@/services/consent_variant';

type Req = FastifyRequest<{ Body: ConsentAcceptBody }>;

export const accept_consent: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/accept',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['consent'],
      body: ConsentAcceptBodySchema,
      response: {
        200: ConsentAcceptResponseSchema,
      },
    },
    handler: accept_consent_handler,
  });
};

export const accept_consent_handler = async (
  request: Req,
  reply: FastifyReply,
) => {
  const userId = request.user?.id;
  if (!userId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required',
    });
  }

  const body = request.body;
  const validNetworks = apiConfig.served_domains.map((b) => b.network);

  if (!validNetworks.includes(body.network)) {
    return reply.code(400).send({
      error: 'UNKNOWN_NETWORK',
      message: `Network "${body.network}" is not served by this instance`,
    });
  }

  // Which document set this acceptance is against (#626). Derived here, not
  // read from the body, for the same reason the version is: a client that
  // chose its own variant would be choosing which terms it is bound by.
  const variant = await resolveUserConsentVariant(userId);

  const acceptedAt = new Date();
  // Versions are derived server-side from the loaded consent config, never
  // trusted from the client (the ledger stores only category + version).
  const rows: Array<{
    level: 'user';
    consentCategory: typeof body.items[number]['category'];
    userId: string;
    network: string;
    brand: string | null;
    documentVersion: number;
    source: typeof body.source;
    acceptedAt: Date;
    metadata: { variant: 'adult' | 'u18' };
  }> = [];
  for (const item of body.items) {
    let version = await resolveConsentVersion({
      network: body.network,
      brand: body.brand,
      category: item.category,
      variant,
    });
    // Most networks ship no `u18_documents` at all. Without this fall-back a
    // minor on one of them resolves to null and is refused below — locking
    // them out of login entirely, which is a far worse outcome than recording
    // against the adult set the deployment actually publishes.
    let effectiveVariant = variant;
    if (version === null && variant === 'u18') {
      version = await resolveConsentVersion({
        network: body.network,
        brand: body.brand,
        category: item.category,
        variant: 'adult',
      });
      effectiveVariant = 'adult';
    }
    if (version === null) {
      return reply.code(400).send({
        error: 'CONSENT_VERSION_UNCONFIGURED',
        message: `No consent version configured for ${item.category} on ${body.network}`,
      });
    }
    rows.push({
      level: 'user',
      consentCategory: item.category,
      userId,
      network: body.network,
      brand: body.brand ?? null,
      documentVersion: version,
      source: body.source,
      acceptedAt,
      // Recorded so the ledger says WHICH set the version belongs to. The two
      // sets are in lockstep today, so the integer alone cannot distinguish
      // them — and `effectiveVariant` reflects the fall-back above, not the
      // intent, so an audit sees what was actually served.
      metadata: { variant: effectiveVariant },
    });
  }

  try {
    await db.insert(consent_record).values(rows);
  } catch (err) {
    request.log.error({ err }, 'Failed to write consent_record rows');
    return reply.code(500).send({
      error: 'CONSENT_WRITE_FAILED',
      message: 'Failed to record consent',
    });
  }

  return reply.code(200).send({ recorded: body.items.length });
};
