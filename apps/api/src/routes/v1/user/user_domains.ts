import z from '@dpg/schemas';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { tagUserForDomain } from '@/services/aggregator/default_aggregator';
import {
  claimDomain,
  domainLockedMessage,
  readLockedDomains,
} from '@/services/items/single_domain_lock';

// `.max(1)`: the column is an array for a future multi-role case, but one
// account may declare exactly one domain (the single-domain lock).
const SetDomainsBody = z.object({ domains: z.array(z.string().min(1)).min(1).max(1) });
const DomainsResponse = z.object({ domains: z.array(z.string()) });
type SetReq = FastifyRequest<{ Body: z.infer<typeof SetDomainsBody> }>;

/**
 * The domain role the current user may create profiles in. Persisted at
 * signup. The profile form uses it to narrow its domain picker.
 *
 * This is an authorization boundary. `user.domains` is the single-domain lock
 * (`services/items/single_domain_lock.ts`), and that invariant is what allows a
 * different default aggregator per domain: `user.onboarded_by_org_id` grants
 * PII-decrypt rights per account, so an account spanning two domains would let
 * one domain's default decrypt the other's participant.
 *
 * So POST is write-once, through the same primitives as the create path: set
 * when unset, accept a no-op repeat, and refuse a different domain with the
 * same `DOMAIN_LOCKED` body `create_item` returns.
 *
 * No reset path: clearing a domain is a support operation
 * (`UPDATE "user" SET domains='{}' WHERE id=…`). Deleting your last profile
 * does not release the lock.
 *
 * Null column → empty array.
 */
export const user_domains: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/domains',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: { tags: ['user'], response: { 200: DomainsResponse } },
    handler: get_domains_handler,
  });

  fastify.route({
    url: '/domains',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: { tags: ['user'], body: SetDomainsBody, response: { 200: DomainsResponse } },
    handler: set_domains_handler,
  });
};

const get_domains_handler = async (request: FastifyRequest, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });
  const [row] = await db.select({ domains: user.domains }).from(user).where(eq(user.id, userId)).limit(1);
  return reply.code(200).send({ domains: row?.domains ?? [] });
};

const set_domains_handler = async (request: SetReq, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });

  // Only real served domains may be stored — reject arbitrary strings, which
  // would otherwise poison the profile-form picker (empty → creation lockout).
  const served = new Set(apiConfig.served_domains.map((b) => b.domain));
  const invalid = request.body.domains.filter((d) => !served.has(d));
  if (invalid.length > 0) {
    return reply.code(400).send({ error: 'UNSERVED_DOMAIN', message: `Not served: ${invalid.join(', ')}` });
  }

  const requested = request.body.domains[0] as string;

  // Write-once, through the same primitives as the create path. Do not inline a
  // copy of the claim: its `NOT EXISTS items` guard is what stops an account
  // with an empty column but existing items from gaining a second domain.
  let effective = [requested];
  if (!(await claimDomain(db, userId, requested))) {
    const held = await readLockedDomains(db, userId);
    // Empty ⇒ the user row is gone. Nothing to lock, nothing to grant.
    if (held.length > 0 && !held.includes(requested)) {
      return reply.code(403).send({
        error: 'DOMAIN_LOCKED',
        message: domainLockedMessage(held[0] as string, requested, 'switch to'),
        locked_domain: held[0],
        requested_domain: requested,
      });
    }
    effective = held.length > 0 ? held : [requested];
  }

  // The user's domain is now decided, so the default aggregator can own them.
  // No-op when they already have an owner or no default is nominated.
  // Best-effort: a tagging failure must not fail the domain write.
  for (const domain of effective) {
    try {
      await tagUserForDomain(db, userId, domain);
    } catch (err) {
      request.log.error({ err, userId, domain }, 'default-aggregator tagging failed');
    }
  }
  return reply.code(200).send({ domains: effective });
};
