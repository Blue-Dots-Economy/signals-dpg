import z, {
  FetchOwnedActionsQuerySchema,
  OwnedItemActionSchema,
} from '@dpg/schemas';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { getCurrentApiBaseUrl } from '@/config';
import { getNetworkConfigs } from '@/network_configs';
import { normalizeInstanceUrl } from '@/utils/action_event_runtime';
import {
  collectOwnedActions,
  type EnrichedAction,
  type OwnedActionsFilters,
} from '@/routes/v1/action/_owned_actions';

type FetchOwnedActionsRequest = FastifyRequest<{
  Querystring: z.infer<typeof FetchOwnedActionsQuerySchema>;
}>;

const FetchOwnedActionsResponseSchema = z.object({
  meta: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  }),
  actions: OwnedItemActionSchema.array(),
});

export const fetch_actions: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/fetch',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      query: FetchOwnedActionsQuerySchema,
      response: {
        200: FetchOwnedActionsResponseSchema,
      },
    },
    handler: fetch_actions_handler,
  });
};

const fetch_actions_handler = async (
  request: FetchOwnedActionsRequest,
  reply: FastifyReply
) => {
  const userId = request.user?.id;

  if (!userId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to fetch actions',
    });
  }

  const { limit, offset, ...rest } = request.query;
  const filters: OwnedActionsFilters = {
    action_id: rest.action_id,
    action_type: rest.action_type,
    action_status: rest.action_status,
    item_id: rest.item_id,
    ownership_role: rest.ownership_role,
  };

  try {
    // Fetch a window large enough to cover the requested page from EACH
    // instance, merge, then paginate the combined set. Cross-instance actions
    // live only on the instance that recorded them (the target's), so a user's
    // initiated requests to a peer instance are invisible to a local-only
    // query — we fan out to peers and merge here.
    const fetchCap = Math.min(100, offset + limit);

    const local = await collectOwnedActions({
      ownerId: userId,
      filters,
      limit: fetchCap,
      offset: 0,
      log: request.log,
    });

    const peerUrls = await getPeerInstanceUrls();
    const peerResults = await Promise.all(
      peerUrls.map((url) =>
        fetchPeerOwnedActions(url, userId, filters, fetchCap, request.log)
      )
    );

    // Dedupe by action_id (an action lives on exactly one instance, but guard
    // against self appearing in a peer list).
    const merged = new Map<string, EnrichedAction>();
    for (const action of [...local.actions, ...peerResults.flat()]) {
      if (!merged.has(action.action_id)) merged.set(action.action_id, action);
    }

    const all = [...merged.values()].sort(
      (a, b) =>
        b.updated_at.getTime() - a.updated_at.getTime() ||
        b.created_at.getTime() - a.created_at.getTime()
    );

    if (all.length >= fetchCap && peerUrls.length > 0) {
      request.log.info(
        { fetchCap, instances: peerUrls.length + 1 },
        'fetch_actions hit per-instance cap; merged total may be truncated'
      );
    }

    const page = all.slice(offset, offset + limit);

    return reply.code(200).send({
      meta: { total: all.length, limit, offset },
      actions: page,
    });
  } catch (err) {
    request.log.error({ err, query: request.query }, 'Failed to fetch actions');
    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch actions',
    });
  }
};

/**
 * Distinct peer instance urls across every served network's instances,
 * excluding this instance itself.
 */
async function getPeerInstanceUrls(): Promise<string[]> {
  const self = normalizeInstanceUrl(getCurrentApiBaseUrl());
  const configs = await getNetworkConfigs();
  const urls = new Map<string, string>();
  for (const cfg of configs) {
    for (const inst of cfg.instances) {
      const norm = normalizeInstanceUrl(inst.instance_url);
      if (norm !== self && !urls.has(norm)) {
        urls.set(norm, inst.instance_url);
      }
    }
  }
  return [...urls.values()];
}

async function fetchPeerOwnedActions(
  instanceUrl: string,
  ownerId: string,
  filters: OwnedActionsFilters,
  limit: number,
  log: FastifyBaseLogger
): Promise<EnrichedAction[]> {
  try {
    const response = await fetch(
      new URL('/api/v1/network/action/fetch_local', instanceUrl),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner_id: ownerId, ...filters, limit, offset: 0 }),
      }
    );

    if (!response.ok) {
      log.warn(
        { instanceUrl, status: response.status },
        'peer action fetch returned non-OK; skipping that instance'
      );
      return [];
    }

    const body = (await response.json()) as {
      actions?: Array<Record<string, unknown>>;
    };
    return (body.actions ?? []).map(normalizePeerAction);
  } catch (err) {
    log.warn({ err, instanceUrl }, 'peer action fetch failed; skipping');
    return [];
  }
}

// Dates arrive as ISO strings over JSON — restore Date objects so sorting and
// the response schema match the locally-produced rows.
function normalizePeerAction(action: Record<string, unknown>): EnrichedAction {
  return {
    ...action,
    created_at: new Date(action.created_at as string),
    updated_at: new Date(action.updated_at as string),
  } as unknown as EnrichedAction;
}
