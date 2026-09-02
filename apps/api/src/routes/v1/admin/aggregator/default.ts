import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { organization } from '../../../../../db/postgres/schema/auth.js';
import { aggregator_default_audit } from '../../../../../db/postgres/schema/aggregator_default_audit.js';
import { isServedDomainBinding } from '@/utils/served_domain_guard';
import z, { AggregatorDefaultRequest, AggregatorDefaultResponse } from '@dpg/schemas';

/**
 * POST /api/v1/admin/aggregator/default
 *
 * Nominates the default aggregator for one or more served-domain bindings
 * (#640, SS-3) — the aggregator that inherits users arriving with no
 * aggregator of their own (portal self-signup, cold inbound voice).
 *
 * Why this is an endpoint rather than a hand-written UPDATE: the column it
 * writes decides who may decrypt an entire inbound population's PII. Raw SQL
 * would leave three gaps this closes in one transaction — nothing enforcing
 * one default per binding, no validation beyond the CHECK constraint, and no
 * record of who changed it or when (`organization` has no `updated_at`).
 *
 * Narrowed to `network_service` callers, same as
 * `POST /api/v1/admin/aggregator/upsert`. Auth + acting-org resolution happen
 * upstream in `admin_routes`' preHandler chain.
 *
 * `bindings: []` clears every binding the org holds — the supported way to
 * stand an aggregator down. Idempotent: re-sending the same set changes
 * nothing and writes no audit rows.
 *
 * Known limit: approval state lives in aggregator-dpg and is not visible here,
 * so this cannot verify the org is approved/enabled. It can only prove the org
 * exists and is `type = 'aggregator'` — i.e. that the network service mirrored
 * it in. That an approved aggregator has an enabled human behind it remains a
 * process guarantee, not an enforced one.
 */
type DefaultRequest = FastifyRequest<{
  Body: z.infer<typeof AggregatorDefaultRequest>;
}>;

export const aggregator_default: FastifyPluginAsync = async (app) => {
  app.route({
    url: '/aggregator/default',
    method: 'POST',
    schema: {
      tags: ['admin'],
      body: AggregatorDefaultRequest,
      response: { 200: AggregatorDefaultResponse },
    },
    handler: aggregator_default_handler,
  });
};

export const aggregator_default_handler = async (
  request: DefaultRequest,
  reply: FastifyReply,
) => {
  if (request.acting_org?.org_type !== 'network_service') {
    return reply.code(403).send({
      error: 'NOT_NETWORK_SERVICE',
      message: 'only the network service caller may nominate a default aggregator',
    });
  }

  const { org_id } = request.body;
  const wanted = [...new Set(request.body.bindings)];

  // Every binding must be one this instance actually serves — a typo would
  // otherwise sit in the column silently and never match a lookup.
  const unserved = wanted.filter((b) => {
    const [network, domain] = b.split('/');
    return !isServedDomainBinding(network, domain);
  });
  if (unserved.length > 0) {
    return reply.code(400).send({
      error: 'UNSERVED_DOMAIN_BINDING',
      message: `This API instance does not serve: ${unserved.join(', ')}`,
    });
  }

  const [target] = await db
    .select({
      id: organization.id,
      type: organization.type,
      metadata: organization.metadata,
    })
    .from(organization)
    .where(eq(organization.id, org_id))
    .limit(1);

  if (!target) {
    return reply.code(404).send({
      error: 'ORG_NOT_FOUND',
      message: `no organization with id "${org_id}"`,
    });
  }

  if (target.type !== 'aggregator') {
    return reply.code(400).send({
      error: 'NOT_AN_AGGREGATOR',
      message: `org "${org_id}" is type "${target.type ?? 'null'}"; only an aggregator can be a default`,
    });
  }

  // The org's own declared domains, mirrored in at /aggregator/upsert. An
  // aggregator that does not report on a domain has no business inheriting its
  // inbound population. Skipped when the org declared none (legacy mirrors).
  const declared = parseDeclaredDomains(target.metadata);
  if (declared.length > 0) {
    const undeclared = wanted.filter((b) => !declared.includes(b.split('/')[1]));
    if (undeclared.length > 0) {
      return reply.code(400).send({
        error: 'DOMAIN_NOT_DECLARED',
        message: `org "${org_id}" does not declare: ${undeclared.join(', ')} (declares: ${declared.join(', ')})`,
      });
    }
  }

  try {
    const cleared_from = await db.transaction(async (tx) => {
      // Read every current holder BEFORE displacing anyone — this is where the
      // audit's `from_org_id` comes from, and it cannot be recovered after the
      // update. `organization` is tens to hundreds of rows, so the set
      // arithmetic is done in JS rather than in array SQL.
      const holders = await tx
        .select({ id: organization.id, bindings: organization.defaultForBindings })
        .from(organization)
        .where(sql`${organization.defaultForBindings} IS NOT NULL`);

      const previousHolder = new Map<string, string>();
      for (const holder of holders) {
        for (const binding of holder.bindings ?? []) previousHolder.set(binding, holder.id);
      }

      const displaced: Array<{ org_id: string; binding: string }> = [];

      for (const holder of holders) {
        if (holder.id === org_id) continue;
        const taken = (holder.bindings ?? []).filter((b) => wanted.includes(b));
        if (taken.length === 0) continue;

        const remaining = (holder.bindings ?? []).filter((b) => !wanted.includes(b));
        await tx
          .update(organization)
          .set({ defaultForBindings: remaining.length === 0 ? null : remaining })
          .where(eq(organization.id, holder.id));

        for (const binding of taken) displaced.push({ org_id: holder.id, binding });
      }

      await tx
        .update(organization)
        .set({ defaultForBindings: wanted.length === 0 ? null : wanted })
        .where(eq(organization.id, org_id));

      // Audit only actual changes, so a repeat call is a genuine no-op.
      const changed = wanted.filter((b) => previousHolder.get(b) !== org_id);
      if (changed.length > 0) {
        await tx.insert(aggregator_default_audit).values(
          changed.map((binding) => ({
            binding,
            fromOrgId: previousHolder.get(binding) ?? null,
            toOrgId: org_id,
            changedBy: request.user?.id ?? 'unknown',
          })),
        );
      }

      return displaced;
    });

    request.log.info({ org_id, bindings: wanted, cleared_from }, 'aggregator default updated');

    return reply.code(200).send({ org_id, bindings: wanted, cleared_from });
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } } | null;
    const pg_code = e?.code ?? e?.cause?.code;
    // 23514 = the organization_default_requires_aggregator CHECK. Reachable
    // only if the org's `type` changed between the read above and the write.
    if (pg_code === '23514') {
      request.log.error({ err, org_id }, 'default aggregator rejected by CHECK constraint');
      return reply.code(400).send({
        error: 'NOT_AN_AGGREGATOR',
        message: 'only an aggregator org can be a default aggregator',
      });
    }
    throw err;
  }
};

/** `metadata.domains` as mirrored in by /aggregator/upsert; [] when absent or unreadable. */
function parseDeclaredDomains(metadata: string | null): string[] {
  if (!metadata) return [];
  try {
    const parsed = JSON.parse(metadata) as { domains?: unknown };
    return Array.isArray(parsed.domains)
      ? parsed.domains.filter((d): d is string => typeof d === 'string')
      : [];
  } catch {
    return [];
  }
}

export default aggregator_default;
