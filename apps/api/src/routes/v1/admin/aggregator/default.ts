import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { organization } from '../../../../../db/postgres/schema/auth.js';
import { aggregator_default_audit } from '../../../../../db/postgres/schema/aggregator_default_audit.js';
import { isServedDomainBinding } from '@/utils/served_domain_guard';
import { readConfiguredDomains } from '@/utils/org_metadata';
import z, {
  AdminErrorResponse,
  AggregatorDefaultRequest,
  AggregatorDefaultResponse,
  parseBindingKey,
} from '@dpg/schemas';

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
      // Failures are declared, not just the 200 — integrating DPGs read the
      // generated OpenAPI document to know what they have to handle.
      response: {
        200: AggregatorDefaultResponse,
        400: AdminErrorResponse,
        403: AdminErrorResponse,
        404: AdminErrorResponse,
        409: AdminErrorResponse,
        500: AdminErrorResponse,
      },
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

  // The audit trail is the only record of who handed an organisation decrypt
  // rights over an inbound population, so a row attributed to 'unknown' would
  // defeat the point of writing one. Behind the admin preHandler chain this is
  // always set; failing loudly beats a useless audit row.
  const actor = request.user?.id;
  if (!actor) {
    request.log.error('aggregator default: authenticated caller has no user id');
    return reply.code(500).send({
      error: 'ACTOR_UNRESOLVED',
      message: 'could not attribute this change to a caller; refusing to write an unattributed audit row',
    });
  }

  const { org_id } = request.body;
  const wanted = [...new Set(request.body.bindings)];

  // Every binding must be one this instance actually serves — a typo would
  // otherwise sit in the column silently and never match a lookup.
  const unserved = wanted.filter((b) => {
    const { network, domain } = parseBindingKey(b);
    return !isServedDomainBinding(network, domain);
  });
  if (unserved.length > 0) {
    return reply.code(400).send({
      error: 'UNSERVED_DOMAIN_BINDING',
      message: `This API instance does not serve: ${unserved.join(', ')}`,
    });
  }

  const [target] = await db
    .select({ id: organization.id, type: organization.type })
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
  const declared = await readConfiguredDomains(org_id);
  if (declared.length > 0) {
    const undeclared = wanted.filter((b) => !declared.includes(parseBindingKey(b).domain));
    if (undeclared.length > 0) {
      return reply.code(400).send({
        error: 'DOMAIN_NOT_DECLARED',
        message: `org "${org_id}" does not declare: ${undeclared.join(', ')} (declares: ${declared.join(', ')})`,
      });
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Serialise every nomination. The holder read below and the writes that
      // follow touch DIFFERENT rows, so at READ COMMITTED two concurrent
      // nominations for the same binding never conflict and both commit —
      // leaving two claimants, which resolution treats as `ambiguous` and which
      // then blocks go-live for the whole instance. Application code is the
      // only thing enforcing exclusivity (Postgres cannot unique-index an array
      // element), so it has to be serialised explicitly.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('aggregator_default'))`);

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

      // Every binding whose holder changed, in BOTH directions. Auditing only
      // additions meant the destructive half went unrecorded: this is a
      // full-set replace, so a binding the target previously held and that is
      // absent from `wanted` is silently revoked — and `bindings: []`, the
      // documented way to stand an aggregator down, wrote zero rows for the
      // single most consequential operation the endpoint supports.
      const previouslyHeld = (holders.find((h) => h.id === org_id)?.bindings ?? []);
      const revoked = previouslyHeld.filter((b) => !wanted.includes(b));
      const granted = wanted.filter((b) => previousHolder.get(b) !== org_id);

      const auditRows = [
        ...granted.map((binding) => ({
          binding,
          fromOrgId: previousHolder.get(binding) ?? null,
          toOrgId: org_id as string | null,
          changedBy: actor,
        })),
        // `to_org_id` null = revoked, nothing took over.
        ...revoked.map((binding) => ({
          binding,
          fromOrgId: org_id as string | null,
          toOrgId: null,
          changedBy: actor,
        })),
      ];

      if (auditRows.length > 0) {
        await tx.insert(aggregator_default_audit).values(auditRows);
      }

      return { displaced, revoked };
    });

    const { displaced: cleared_from, revoked } = result;

    request.log.info(
      { org_id, bindings: wanted, cleared_from, revoked },
      'aggregator default updated',
    );

    return reply.code(200).send({ org_id, bindings: wanted, cleared_from, revoked });
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } } | null;
    const pg_code = e?.code ?? e?.cause?.code;
    // 23514 = the organization_default_requires_aggregator CHECK. Reachable
    // only if the org's `type` changed between the read above and the write.
    // 23505 = organization_single_default_idx. The advisory lock serialises the
    // normal clear-then-set flow, so this is only reachable if a default were
    // set outside this endpoint; surface it as a conflict rather than a 500.
    if (pg_code === '23505') {
      request.log.error({ err, org_id }, 'another org is already the default aggregator');
      return reply.code(409).send({
        error: 'DEFAULT_ALREADY_SET',
        message:
          'another organization is already the default aggregator; clear it first (ownership is account-level, so only one default may exist)',
      });
    }
    if (pg_code === '23514') {
      request.log.error({ err, org_id }, 'default aggregator rejected by CHECK constraint');
      return reply.code(400).send({
        error: 'NOT_AN_AGGREGATOR',
        message: 'only an aggregator org can be a default aggregator',
      });
    }
    // Never surface the raw error message: a DB error's text can include the
    // failed SQL and its bound params (same reasoning as the participant
    // route). The app registers no setErrorHandler, so a re-throw would echo it
    // straight to the caller.
    request.log.error({ err, org_id, bindings: wanted }, 'default aggregator write failed');
    return reply.code(500).send({
      error: 'DEFAULT_AGGREGATOR_WRITE_FAILED',
      message: 'failed to update the default aggregator',
    });
  }
};

export default aggregator_default;
