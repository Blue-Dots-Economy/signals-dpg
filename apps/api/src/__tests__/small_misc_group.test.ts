import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { NotificationEvent, NotificationPlan } from '@/notifications/build_notifications';

/**
 * Cross-directory unit tests closing the last uncovered branches in four small
 * modules that each have too little surface for a file of their own:
 *
 *   - routes/v1/match_score/calculate_match_score.ts (503 / 200 / 502)
 *   - routes/v1/network/item/markers.ts              (unserved-domain + catch
 *                                                     arms of both handlers,
 *                                                     and the peer-supplied
 *                                                     text_search override)
 *   - notifications/notify_actions.ts                (config memoisation, brand
 *                                                     fallback, dispatcher deps)
 *   - services/consent_version.ts                    (the `action` category)
 *
 * Neither route handler is exported, so each plugin is registered against a
 * fake fastify and the captured handler is invoked directly against a
 * chainable fake reply.
 */

// --- captured-route plumbing ----------------------------------------------

interface CapturedRoute {
  url: string;
  method: string;
  preHandler?: unknown;
  // Fastify's typed request/reply are irrelevant here: the handler is driven
  // with hand-built fakes, so the params stay intentionally untyped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (request: any, reply: any) => Promise<unknown>;
}

type FakeReply = {
  code: (statusCode: number) => FakeReply;
  send: (body: unknown) => FakeReply;
  header: (key: string, value: string) => FakeReply;
};

function makeReply() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  };
  const reply: FakeReply = {
    code: (statusCode) => {
      res.statusCode = statusCode;
      return reply;
    },
    send: (body) => {
      res.body = body;
      return reply;
    },
    header: (key, value) => {
      res.headers[key] = value;
      return reply;
    },
  };
  return { reply, res };
}

function makeLog() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
}

async function captureRoutes(
  plugin: (fastify: never, opts: never) => Promise<void>,
): Promise<CapturedRoute[]> {
  const routes: CapturedRoute[] = [];
  const fastify = { route: (def: CapturedRoute) => void routes.push(def) };
  await plugin(fastify as never, {} as never);
  return routes;
}

// --- mocks (hoisted) -------------------------------------------------------

const {
  getMatchScoreClient,
  isServedDomainBinding,
  replyForUnservedDomain,
  fetchLocalMarkers,
  fetchMarkersAcrossInstances,
  getNetworkConfigById,
  resolveTextSearchFields,
  peerGuard,
  cfgInstance,
  cfgNotification,
  getNotificationClient,
  buildCtaUrl,
  resolveBrandName,
  createDirectDispatcher,
  dispatch,
  resolveRecipientRole,
  resolveOwnerEmail,
  resolveProviderServiceName,
  schemaEntries,
} = vi.hoisted(() => ({
  getMatchScoreClient: vi.fn(),
  isServedDomainBinding: vi.fn((_network: string, _domain: string) => true),
  replyForUnservedDomain: vi.fn(
    async (
      reply: { code: (c: number) => { send: (b: unknown) => unknown } },
      network: string,
      domain: string,
    ) =>
      reply.code(403).send({
        error: 'UNSERVED_DOMAIN_BINDING',
        message: `This API instance does not serve "${network}/${domain}".`,
      }),
  ),
  fetchLocalMarkers: vi.fn(),
  fetchMarkersAcrossInstances: vi.fn(),
  getNetworkConfigById: vi.fn(),
  resolveTextSearchFields: vi.fn(),
  peerGuard: vi.fn(),
  // Mutated in place by the notify_actions tests; the module under test reads
  // these properties at call time, not at import time.
  cfgInstance: { INSTANCE_NAME: 'test-instance' } as { INSTANCE_NAME: string },
  cfgNotification: {} as {
    NOTIFICATION_FROM_EMAIL?: string;
    NOTIFICATION_REPLY_TO?: string;
    FRONTEND_BASE_URL?: string;
  },
  getNotificationClient: vi.fn(),
  buildCtaUrl: vi.fn((_baseUrl: string) => 'https://app.test/login'),
  resolveBrandName: vi.fn(
    (_opts: { networkDisplayName?: string; instanceName?: string }) => 'BRAND',
  ),
  createDirectDispatcher: vi.fn(
    (_deps: unknown): { dispatch: (event: unknown) => Promise<undefined> } => ({
      dispatch: async () => undefined,
    }),
  ),
  dispatch: vi.fn(async (_event: unknown) => undefined),
  resolveRecipientRole: vi.fn((_domain: string): string => 'seeker'),
  resolveOwnerEmail: vi.fn(async (_userId: string): Promise<string | null> => null),
  resolveProviderServiceName: vi.fn(
    async (_itemId: string, _network: string): Promise<string | null> => null,
  ),
  schemaEntries: [] as {
    kind: string;
    network: string;
    brand?: string | null;
    schema: unknown;
  }[],
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));
vi.mock('@/utils/match_score_client', () => ({
  getMatchScoreClient: () => getMatchScoreClient(),
}));
vi.mock('@/utils/served_domain_guard', () => ({
  isServedDomainBinding: (n: string, d: string) => isServedDomainBinding(n, d),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  replyForUnservedDomain: (...a: any[]) => replyForUnservedDomain(a[0], a[1], a[2]),
}));
vi.mock('@/utils/item_fetch_runtime', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchLocalMarkers: (...a: any[]) => fetchLocalMarkers(...a),
}));
vi.mock('@/utils/inter_instance_fetch', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchMarkersAcrossInstances: (...a: any[]) => fetchMarkersAcrossInstances(...a),
}));
vi.mock('@/network_configs', () => ({
  getNetworkConfigById: (id: string) => getNetworkConfigById(id),
}));
vi.mock('@/utils/facet_guard', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveTextSearchFields: (...a: any[]) => resolveTextSearchFields(...a),
}));
vi.mock('@/middleware/peer_instance_guard', () => ({
  peer_instance_guard: peerGuard,
}));
vi.mock('@/config', () => ({
  instance: cfgInstance,
  notification: cfgNotification,
}));
vi.mock('@/utils/notificationClient', () => ({
  getNotificationClient: () => getNotificationClient(),
}));
vi.mock('@/notifications/brand', () => ({
  buildCtaUrl: (b: string) => buildCtaUrl(b),
  resolveBrandName: (o: { networkDisplayName?: string; instanceName?: string }) =>
    resolveBrandName(o),
}));
vi.mock('@/notifications/dispatcher', () => ({
  createDirectDispatcher: (deps: unknown) => createDirectDispatcher(deps),
}));
vi.mock('@/notifications/action_copy', () => ({
  resolveRecipientRole: (d: string) => resolveRecipientRole(d),
}));
vi.mock('@/notifications/resolve_owner', () => ({
  resolveOwnerEmail,
  resolveProviderServiceName,
}));
vi.mock('@/network_schema_cache', () => ({
  getConfiguredNetworkSchemas: async () => schemaEntries,
}));

// --- modules under test (imported after the mocks) -------------------------

import { calculate_match_score } from '@/routes/v1/match_score/calculate_match_score';
import { markers } from '@/routes/v1/network/item/markers';
import {
  dispatchActionNotifications,
  resetActionNotifierConfigForTests,
  resolveNetworkBrandName,
  resolveNotifierConfig,
} from '@/notifications/notify_actions';
import { resolveConsentVersion } from '@/services/consent_version';

beforeEach(() => {
  vi.clearAllMocks();
  // Re-arm every default implementation explicitly: clearAllMocks wipes calls
  // but any per-test `mockImplementationOnce` must not leak either way.
  getMatchScoreClient.mockImplementation(() => undefined);
  isServedDomainBinding.mockImplementation(() => true);
  replyForUnservedDomain.mockImplementation(async (reply, network, domain) =>
    reply.code(403).send({
      error: 'UNSERVED_DOMAIN_BINDING',
      message: `This API instance does not serve "${network}/${domain}".`,
    }),
  );
  fetchLocalMarkers.mockImplementation(async () => ({
    meta: { total: 1, limit: 10, offset: 0 },
    markers: [],
  }));
  fetchMarkersAcrossInstances.mockImplementation(async () => ({
    meta: {
      total: 2,
      limit: 10,
      offset: 0,
      partial: true,
      unavailable_instances: ['https://peer-b'],
    },
    markers: [],
  }));
  getNetworkConfigById.mockImplementation(async () => ({
    id: 'yellow_dot',
    display_name: 'Yellow Dot',
    domains: [{ id: 'student' }],
  }));
  resolveTextSearchFields.mockImplementation(() => ['title', 'about']);
  buildCtaUrl.mockImplementation(() => 'https://app.test/login');
  resolveBrandName.mockImplementation(() => 'BRAND');
  createDirectDispatcher.mockImplementation(() => ({ dispatch }));
  dispatch.mockImplementation(async () => undefined);
  resolveRecipientRole.mockImplementation(() => 'seeker');
  resolveOwnerEmail.mockImplementation(async () => null);
  resolveProviderServiceName.mockImplementation(async () => null);

  cfgInstance.INSTANCE_NAME = 'test-instance';
  delete cfgNotification.NOTIFICATION_FROM_EMAIL;
  delete cfgNotification.NOTIFICATION_REPLY_TO;
  delete cfgNotification.FRONTEND_BASE_URL;
  getNotificationClient.mockImplementation(() => null);
  resetActionNotifierConfigForTests();

  schemaEntries.length = 0;
});

// ===========================================================================
// calculate_match_score.ts
// ===========================================================================

describe('POST /api/v1/match_score/calculate', () => {
  const body = {
    itemA: { item_id: 'item-a', item_state: {} },
    itemB: { item_id: 'item-b', item_state: {} },
  };

  async function handler() {
    const routes = await captureRoutes(calculate_match_score);
    expect(routes).toHaveLength(1);
    expect(routes[0].url).toBe('/calculate');
    expect(routes[0].method).toBe('POST');
    // The route carries its own auth preHandler — match_score_routes has no
    // group-level hook, so an omission here would leave it unauthenticated.
    expect(routes[0].preHandler).toBeTypeOf('function');
    return routes[0].handler;
  }

  it('returns 503 MATCH_SCORE_NOT_CONFIGURED when no provider is configured', async () => {
    const run = await handler();
    const { reply, res } = makeReply();
    await run({ body, log: makeLog() }, reply);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: 'MATCH_SCORE_NOT_CONFIGURED',
      message: 'Match score provider is not configured',
    });
  });

  it('returns 200 with the provider result on success', async () => {
    const calculate = vi.fn(async (_req: unknown) => ({
      provider: 'signals_search',
      score: 0.75,
      raw_response: { ok: true },
    }));
    getMatchScoreClient.mockImplementation(() => ({ calculate }));

    const run = await handler();
    const { reply, res } = makeReply();
    await run({ body, log: makeLog() }, reply);

    expect(calculate).toHaveBeenCalledWith(body);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      provider: 'signals_search',
      score: 0.75,
      raw_response: { ok: true },
    });
  });

  it('maps a provider failure to 502 and logs both item ids', async () => {
    const boom = new Error('upstream 500');
    getMatchScoreClient.mockImplementation(() => ({
      calculate: async () => {
        throw boom;
      },
    }));

    const run = await handler();
    const { reply, res } = makeReply();
    const log = makeLog();
    await run({ body, log }, reply);

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({
      error: 'MATCH_SCORE_SERVICE_UNAVAILABLE',
      message: 'Failed to reach the configured match score provider',
    });
    expect(log.error).toHaveBeenCalledTimes(1);
    const [meta, message] = log.error.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(meta).toMatchObject({
      err: boom,
      provider: 'signals_search',
      item_a_id: 'item-a',
      item_b_id: 'item-b',
    });
    expect(message).toBe('Failed to calculate match score');
  });
});

// ===========================================================================
// markers.ts
// ===========================================================================

describe('network markers handlers', () => {
  const query = {
    item_network: 'yellow_dot',
    item_domain: 'student',
    item_type: 'profile_1.0',
    limit: 10,
    offset: 0,
    min_lat: 1,
    min_lng: 2,
    max_lat: 3,
    max_lng: 4,
  };

  async function handlers() {
    const routes = await captureRoutes(markers);
    expect(routes.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /item/markers',
      'POST /item/markers_local',
    ]);
    // markers_local is peer-only: guarded by the HMAC instance-token guard,
    // never by user auth.
    expect(routes[1].preHandler).toBe(peerGuard);
    return { aggregate: routes[0].handler, local: routes[1].handler };
  }

  describe('GET /item/markers', () => {
    it('403s an item_domain the network config does not declare, without fanning out', async () => {
      getNetworkConfigById.mockImplementation(async () => ({
        id: 'yellow_dot',
        domains: [{ id: 'mentor' }],
      }));

      const { aggregate } = await handlers();
      const { reply, res } = makeReply();
      await aggregate({ query, log: makeLog() }, reply);

      expect(res.statusCode).toBe(403);
      expect((res.body as { error: string }).error).toBe('UNSERVED_DOMAIN_BINDING');
      expect(replyForUnservedDomain).toHaveBeenCalledWith(
        reply,
        'yellow_dot',
        'student',
      );
      expect(fetchMarkersAcrossInstances).not.toHaveBeenCalled();
    });

    it('forwards live_only + the resolved text_search fields and surfaces partiality via header', async () => {
      const { aggregate } = await handlers();
      const { reply, res } = makeReply();
      await aggregate({ query: { ...query, q: 'physics' }, log: makeLog() }, reply);

      const args = fetchMarkersAcrossInstances.mock.calls[0][0] as {
        filters: Record<string, unknown>;
        requestedCacheTtlSeconds: unknown;
      };
      expect(args.filters.lifecycle_filter).toBe('live_only');
      expect(args.filters.text_search).toEqual({
        q: 'physics',
        fields: ['title', 'about'],
      });
      expect(resolveTextSearchFields).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'yellow_dot' }),
        'student',
        'profile_1.0',
      );
      expect(res.headers['x-network-partial']).toBe('true');
      expect(res.statusCode).toBe(200);
    });

    it('returns a clean 500 when the fan-out rejects', async () => {
      const boom = new Error('all peers down');
      fetchMarkersAcrossInstances.mockImplementationOnce(() => Promise.reject(boom));

      const { aggregate } = await handlers();
      const { reply, res } = makeReply();
      const log = makeLog();
      await aggregate({ query, log }, reply);

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch markers across network instances',
      });
      expect(log.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /item/markers_local', () => {
    const body = {
      item_network: 'yellow_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
      limit: 10,
      offset: 0,
    };

    it('403s a binding this instance does not serve, before touching the DB', async () => {
      isServedDomainBinding.mockImplementation(() => false);

      const { local } = await handlers();
      const { reply, res } = makeReply();
      await local({ body, log: makeLog() }, reply);

      expect(res.statusCode).toBe(403);
      expect((res.body as { error: string }).error).toBe('UNSERVED_DOMAIN_BINDING');
      expect(fetchLocalMarkers).not.toHaveBeenCalled();
    });

    it('resolves its OWN field allowlist for q and overrides any peer-supplied text_search', async () => {
      const { local } = await handlers();
      const { reply, res } = makeReply();
      await local(
        {
          // A malicious/stale peer body claiming a private field allowlist.
          body: { ...body, q: 'chem', text_search: { q: 'chem', fields: ['secret_notes'] } },
          log: makeLog(),
        },
        reply,
      );

      expect(getNetworkConfigById).toHaveBeenCalledWith('yellow_dot');
      expect(resolveTextSearchFields).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'yellow_dot' }),
        'student',
        'profile_1.0',
      );
      const filters = fetchLocalMarkers.mock.calls[0][0] as Record<string, unknown>;
      expect(filters.text_search).toEqual({ q: 'chem', fields: ['title', 'about'] });
      expect(filters.lifecycle_filter).toBe('live_only');
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ meta: { total: 1, limit: 10, offset: 0 }, markers: [] });
    });

    it('skips the config read entirely when q is absent and drops a peer text_search', async () => {
      const { local } = await handlers();
      const { reply, res } = makeReply();
      await local(
        { body: { ...body, text_search: { q: 'x', fields: ['secret_notes'] } }, log: makeLog() },
        reply,
      );

      expect(getNetworkConfigById).not.toHaveBeenCalled();
      expect(resolveTextSearchFields).not.toHaveBeenCalled();
      const filters = fetchLocalMarkers.mock.calls[0][0] as Record<string, unknown>;
      expect(filters.text_search).toBeUndefined();
      expect(res.statusCode).toBe(200);
    });

    it('returns a clean 500 when the local read rejects', async () => {
      fetchLocalMarkers.mockImplementationOnce(() => Promise.reject(new Error('pg down')));

      const { local } = await handlers();
      const { reply, res } = makeReply();
      const log = makeLog();
      await local({ body, log }, reply);

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch local markers',
      });
      expect(log.error).toHaveBeenCalledTimes(1);
    });
  });
});

// ===========================================================================
// notify_actions.ts
// ===========================================================================

interface CapturedDeps {
  notify: (req: unknown) => Promise<unknown>;
  resolveEmail: unknown;
  resolveCounterpartyName: (plan: NotificationPlan) => Promise<string | null>;
  brand: { brandName: string; fromEmail: string; replyTo: string; ctaUrl: string };
  log: (message: string, meta?: Record<string, unknown>) => void;
  onSkip: (reason: string) => void;
}

function configureNotifications(replyTo?: string) {
  cfgNotification.NOTIFICATION_FROM_EMAIL = 'from@dpg.test';
  cfgNotification.FRONTEND_BASE_URL = 'https://app.test';
  if (replyTo) cfgNotification.NOTIFICATION_REPLY_TO = replyTo;
  const notify = vi.fn(async (_req: unknown) => 'queued');
  getNotificationClient.mockImplementation(() => ({ notify }));
  return notify;
}

const event: NotificationEvent = {
  lifecycle: 'created',
  actionType: 'connect',
  actionId: 'act-1',
  status: 'created',
  updateCount: 0,
  source: {
    ownerUserId: 'usr-a',
    itemId: 'item-a',
    domain: 'seeker',
    network: 'blue_dot',
    instanceUrl: 'https://a',
  },
  target: {
    ownerUserId: 'usr-b',
    itemId: 'item-b',
    domain: 'provider',
    network: 'blue_dot',
    instanceUrl: 'https://b',
  },
  currentInstanceUrl: 'https://a',
};

const plan: NotificationPlan = {
  recipientUserId: 'usr-a',
  recipientDomain: 'seeker',
  counterpartyItemId: 'item-b',
  counterpartyDomain: 'provider',
  counterpartyNetwork: 'blue_dot',
  shape: 'seeker_action_created' as NotificationPlan['shape'],
  actionType: 'connect',
  status: 'created',
  actionId: 'act-1',
  updateCount: 0,
};

describe('resolveNotifierConfig', () => {
  it('memoises the not-configured verdict (client missing) without re-probing', () => {
    expect(resolveNotifierConfig()).toBeNull();
    expect(resolveNotifierConfig()).toBeNull();
    expect(getNotificationClient).toHaveBeenCalledTimes(1);
  });

  it('is not configured when the client exists but FRONTEND_BASE_URL is unset', () => {
    cfgNotification.NOTIFICATION_FROM_EMAIL = 'from@dpg.test';
    getNotificationClient.mockImplementation(() => ({ notify: vi.fn() }));

    expect(resolveNotifierConfig()).toBeNull();
  });

  it('is not configured when the from-email is unset', () => {
    cfgNotification.FRONTEND_BASE_URL = 'https://app.test';
    getNotificationClient.mockImplementation(() => ({ notify: vi.fn() }));

    expect(resolveNotifierConfig()).toBeNull();
  });

  it('falls back to the from-email as replyTo and delegates notify to the NS client', async () => {
    const notify = configureNotifications();

    const config = resolveNotifierConfig();
    expect(config).not.toBeNull();
    expect(config?.fromEmail).toBe('from@dpg.test');
    expect(config?.replyTo).toBe('from@dpg.test');
    expect(config?.ctaUrl).toBe('https://app.test/login');
    expect(buildCtaUrl).toHaveBeenCalledWith('https://app.test');

    await expect(config?.notify({ to: 'x@y.z' } as never)).resolves.toBe('queued');
    expect(notify).toHaveBeenCalledWith({ to: 'x@y.z' });

    // Memoised: the second call returns the same object without re-probing.
    expect(resolveNotifierConfig()).toBe(config);
    expect(getNotificationClient).toHaveBeenCalledTimes(1);
  });

  it('prefers an explicit NOTIFICATION_REPLY_TO', () => {
    configureNotifications('reply@dpg.test');
    expect(resolveNotifierConfig()?.replyTo).toBe('reply@dpg.test');
  });
});

describe('resolveNetworkBrandName', () => {
  it("uses the network's display_name alongside the instance name", async () => {
    resolveBrandName.mockImplementation((o) => `${o.networkDisplayName ?? o.instanceName}`);

    await expect(resolveNetworkBrandName('yellow_dot')).resolves.toBe('Yellow Dot');
    expect(resolveBrandName).toHaveBeenCalledWith({
      networkDisplayName: 'Yellow Dot',
      instanceName: 'test-instance',
    });
  });

  it('falls back to the instance name when the network config lookup throws', async () => {
    getNetworkConfigById.mockImplementation(async () => {
      throw new Error('unknown network');
    });
    resolveBrandName.mockImplementation((o) => `${o.instanceName}`);

    await expect(resolveNetworkBrandName('nope')).resolves.toBe('test-instance');
    expect(resolveBrandName).toHaveBeenCalledWith({ instanceName: 'test-instance' });
  });
});

describe('dispatchActionNotifications', () => {
  it('is a no-op when notifications are not configured', async () => {
    const log = makeLog();
    await dispatchActionNotifications(event, log as never);

    expect(createDirectDispatcher).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('wires the dispatcher with the per-network brand and dispatches the event', async () => {
    configureNotifications('reply@dpg.test');
    resolveBrandName.mockImplementation(() => 'Blue Dot');

    const log = makeLog();
    await dispatchActionNotifications(event, log as never);

    expect(getNetworkConfigById).toHaveBeenCalledWith('blue_dot');
    const deps = createDirectDispatcher.mock.calls[0][0] as CapturedDeps;
    expect(deps.brand).toEqual({
      brandName: 'Blue Dot',
      fromEmail: 'from@dpg.test',
      replyTo: 'reply@dpg.test',
      ctaUrl: 'https://app.test/login',
    });
    expect(deps.resolveEmail).toBe(resolveOwnerEmail);
    expect(dispatch).toHaveBeenCalledWith(event);
  });

  it('resolves the counterparty name only for provider-side counterparties', async () => {
    configureNotifications();
    await dispatchActionNotifications(event, makeLog() as never);
    const deps = createDirectDispatcher.mock.calls[0][0] as CapturedDeps;

    resolveRecipientRole.mockImplementation(() => 'provider');
    resolveProviderServiceName.mockImplementation(async () => 'Acme Tutoring');
    await expect(deps.resolveCounterpartyName(plan)).resolves.toBe('Acme Tutoring');
    expect(resolveRecipientRole).toHaveBeenCalledWith('provider');
    expect(resolveProviderServiceName).toHaveBeenCalledWith('item-b', 'blue_dot');

    resolveRecipientRole.mockImplementation(() => 'seeker');
    await expect(deps.resolveCounterpartyName(plan)).resolves.toBeNull();
    expect(resolveProviderServiceName).toHaveBeenCalledTimes(1);
  });

  it('routes dispatcher log/onSkip through warn/info, defaulting missing meta to {}', async () => {
    configureNotifications();
    const log = makeLog();
    await dispatchActionNotifications(event, log as never);
    const deps = createDirectDispatcher.mock.calls[0][0] as CapturedDeps;

    deps.log('with meta', { actionId: 'act-1' });
    expect(log.warn).toHaveBeenCalledWith({ actionId: 'act-1' }, 'with meta');

    deps.log('no meta');
    expect(log.warn).toHaveBeenLastCalledWith({}, 'no meta');

    deps.onSkip('no_email');
    expect(log.info).toHaveBeenCalledWith(
      { reason: 'no_email' },
      'action notification skipped',
    );
  });
});

// ===========================================================================
// consent_version.ts — the `action` category
// ===========================================================================

describe('resolveConsentVersion — action statements', () => {
  function seed(entries: typeof schemaEntries) {
    schemaEntries.length = 0;
    schemaEntries.push(...entries);
  }

  it('returns null when actionType is missing', async () => {
    seed([
      {
        kind: 'consent_config',
        network: 'blue_dot',
        schema: { actions: { connect: { initiate: { current_version: 3 } } } },
      },
    ]);

    await expect(
      resolveConsentVersion({ network: 'blue_dot', category: 'action', stage: 'initiate' }),
    ).resolves.toBeNull();
  });

  it('returns null when the stage is missing', async () => {
    seed([
      {
        kind: 'consent_config',
        network: 'blue_dot',
        schema: { actions: { connect: { initiate: { current_version: 3 } } } },
      },
    ]);

    await expect(
      resolveConsentVersion({
        network: 'blue_dot',
        category: 'action',
        actionType: 'connect',
      }),
    ).resolves.toBeNull();
  });

  it('resolves the network default for a configured action/stage', async () => {
    seed([
      // A non-consent entry for the same network must be ignored.
      { kind: 'network_config', network: 'blue_dot', schema: { actions: { connect: { initiate: { current_version: 99 } } } } },
      {
        kind: 'consent_config',
        network: 'blue_dot',
        schema: {
          actions: {
            connect: { initiate: { current_version: 3 }, accept: { current_version: 4 } },
          },
        },
      },
    ]);

    await expect(
      resolveConsentVersion({
        network: 'blue_dot',
        category: 'action',
        actionType: 'connect',
        stage: 'accept',
      }),
    ).resolves.toBe(4);
  });

  it('prefers the brand override over the network default', async () => {
    seed([
      {
        kind: 'consent_config',
        network: 'blue_dot',
        brand: null,
        schema: { actions: { connect: { initiate: { current_version: 3 } } } },
      },
      {
        kind: 'consent_config',
        network: 'blue_dot',
        brand: 'acme',
        schema: { actions: { connect: { initiate: { current_version: 7 } } } },
      },
    ]);

    await expect(
      resolveConsentVersion({
        network: 'blue_dot',
        brand: 'acme',
        category: 'action',
        actionType: 'connect',
        stage: 'initiate',
      }),
    ).resolves.toBe(7);
  });

  it('falls back to the network default when the brand omits that action', async () => {
    seed([
      {
        kind: 'consent_config',
        network: 'blue_dot',
        schema: { actions: { connect: { initiate: { current_version: 3 } } } },
      },
      { kind: 'consent_config', network: 'blue_dot', brand: 'acme', schema: { actions: {} } },
    ]);

    await expect(
      resolveConsentVersion({
        network: 'blue_dot',
        brand: 'acme',
        category: 'action',
        actionType: 'connect',
        stage: 'initiate',
      }),
    ).resolves.toBe(3);
  });

  it('returns null for an unconfigured action, a non-numeric version, and an unknown network', async () => {
    seed([
      {
        kind: 'consent_config',
        network: 'blue_dot',
        schema: { actions: { review: { initiate: { current_version: 'v2' } } } },
      },
    ]);

    // Configured action, but the version is not a number.
    await expect(
      resolveConsentVersion({
        network: 'blue_dot',
        category: 'action',
        actionType: 'review',
        stage: 'initiate',
      }),
    ).resolves.toBeNull();

    // Action absent from the config entirely.
    await expect(
      resolveConsentVersion({
        network: 'blue_dot',
        category: 'action',
        actionType: 'connect',
        stage: 'initiate',
      }),
    ).resolves.toBeNull();

    // No consent config for the network at all.
    await expect(
      resolveConsentVersion({
        network: 'green_dot',
        category: 'action',
        actionType: 'connect',
        stage: 'initiate',
      }),
    ).resolves.toBeNull();
  });

  it('prefers the brand document set for a plain document category', async () => {
    seed([
      {
        kind: 'consent_config',
        network: 'blue_dot',
        schema: { documents: { terms: { current_version: 1 } } },
      },
      {
        kind: 'consent_config',
        network: 'blue_dot',
        brand: 'acme',
        schema: { documents: { terms: { current_version: 5 } } },
      },
    ]);

    await expect(
      resolveConsentVersion({ network: 'blue_dot', brand: 'acme', category: 'terms' }),
    ).resolves.toBe(5);
    // Without the brand hint the default is used, even though the entry exists.
    await expect(
      resolveConsentVersion({ network: 'blue_dot', category: 'terms' }),
    ).resolves.toBe(1);
  });
});
