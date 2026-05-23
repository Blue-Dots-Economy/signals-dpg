import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { organization } from '../../../../../db/postgres/schema/auth.js';
import z, {
  AggregatorUpsertRequest,
  AggregatorUpsertResponse,
} from '@dpg/schemas';

/**
 * POST /api/v1/admin/aggregator/upsert
 *
 * Plan 1 Task 8. Lets the network-service caller (aggregator-dpg's service
 * apikey) mirror an aggregator org into Signals' organization table.
 *
 * Auth + acting_org resolution happens upstream in admin_routes' preHandler
 * chain (Tasks 3-5). This handler additionally narrows the permitted
 * acting_org.org_type to 'network_service' — only the network-service caller
 * is allowed to write aggregator org rows.
 *
 * Lookup key is `slug`. `external_id` is opaque to Signals and is stored
 * inside organization.metadata (avoids a schema change on the organization
 * table).
 */
type UpsertRequest = FastifyRequest<{
  Body: z.infer<typeof AggregatorUpsertRequest>;
}>;

export const aggregator_upsert: FastifyPluginAsync = async (app) => {
  app.route({
    url: '/aggregator/upsert',
    method: 'POST',
    schema: {
      tags: ['admin'],
      body: AggregatorUpsertRequest,
      response: { 200: AggregatorUpsertResponse },
    },
    handler: aggregator_upsert_handler,
  });
};

export const aggregator_upsert_handler = async (
  request: UpsertRequest,
  reply: FastifyReply,
) => {
  if (request.acting_org?.org_type !== 'network_service') {
    return reply.code(403).send({
      error: 'NOT_NETWORK_SERVICE',
      message: 'only the network service caller may mirror aggregator orgs',
    });
  }

  const { external_id, name, slug, logo_url, domains, metadata } = request.body;

  const [existing] = await db
    .select({ id: organization.id, metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);

  const meta_obj = { ...(metadata ?? {}), external_id, domains: domains ?? [] };
  const meta_str = JSON.stringify(meta_obj);

  if (existing) {
    await db
      .update(organization)
      .set({
        name,
        logo: logo_url ?? null,
        metadata: meta_str,
      })
      .where(eq(organization.id, existing.id));
    return reply.code(200).send({ org_id: existing.id, created: false });
  }

  const org_id = `org_${randomUUID()}`;
  try {
    await db.insert(organization).values({
      id: org_id,
      name,
      slug,
      logo: logo_url ?? null,
      type: 'aggregator',
      metadata: meta_str,
      createdAt: new Date(),
    });
  } catch (err) {
    const e = err as { code?: string; message?: string } | null;
    if (e?.code === '23505') {
      request.log.error({ err, slug }, 'aggregator slug collision');
      return reply.code(409).send({
        error: 'SLUG_TAKEN',
        message: `slug "${slug}" is already in use`,
      });
    }
    throw err;
  }
  return reply.code(200).send({ org_id, created: true });
};

export default aggregator_upsert;
