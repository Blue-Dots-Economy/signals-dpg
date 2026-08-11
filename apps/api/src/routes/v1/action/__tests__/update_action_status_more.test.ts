import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Gap coverage for POST /api/v1/action/update-status (bulk).
 *
 * `update_action_status.test.ts` already covers the happy paths, ownership
 * guards, the cancellation rules and the plain consent gate. This file targets
 * the branches that suite never reaches:
 *   - INVALID_PAYLOAD / INVALID_ACTION_EVENT (both throw sites)
 *   - PARTITION_SETUP_FAILED, ACTION_CONFLICT, INTERNAL_SERVER_ERROR
 *   - CONSENT_WRITE_FAILED (null version + insert failure, adult AND guardian)
 *   - the U18 `verified` branch that writes the guardian accept-consent row
 *   - the bulk accept pre-pass (`buildBulkGuardianAcceptGate`): batching, its
 *     skip paths, and the fail-safe fallback to the per-item gate
 *   - source-item liveness / off-instance source snapshot branches
 */

const KNOWN_ACTION_ID = '00000000-0000-4000-8000-000000000aaa';
const OTHER_ACTION_ID = '00000000-0000-4000-8000-000000000bbb';

vi.mock('@/config', () => ({
  apiConfig: {
    domain: 'http://source.local',
    port: 3000,
    served_domains: [],
    network_config_source: 'local',
    network_config_local_file: '',
    network_config_urls: [],
    allow_extra_schema_data: true,
    bulk_max_items: 100,
    schema_registry_url: '',
  },
  authConfig: {
    secret: 'test-secret',
    middleware_enabled: false,
    url: 'http://source.local/api/auth',
    create_test_otp: false,
  },
  matchScoreConfig: { provider: 'noop', signals_search: {} },
  getCurrentApiBaseUrl: () => 'http://source.local',
  instance: { INSTANCE_NAME: 'test', INSTANCE_ENV: 'development' },
  api: { API_DOMAIN: 'http://source.local', API_PORT: 3000 },
  auth: {},
  databases: {},
  matchScore: {},
  notification: {},
  networkRuntime: {},
  schemaRegistry: {},
}));

vi.mock('@/routes/auth/create_auth', () => ({
  authInstance: {
    api: { getSession: vi.fn(async () => null) },
    handler: vi.fn(),
  },
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: vi.fn(async () => {}),
  auth_middleware: vi.fn(async () => {}),
}));

/**
 * Mutable DB behaviour. Every knob is reset in `beforeEach` (never by
 * monkey-patching a shared queue mid-test).
 */
const dbState: {
  /** Row returned by the action lookup unless `rowQueue` is set. */
  baseRow: Record<string, unknown> | null;
  /** Per-select-call answers, consumed in order (pre-pass then main loop). */
  rowQueue: Array<Record<string, unknown> | null> | undefined;
  updates: Array<Record<string, unknown>>;
  inserted: Array<Record<string, unknown>>;
  /** UPDATE ... RETURNING yields no row → optimistic-concurrency conflict. */
  updateReturnsNoRow: boolean;
  /** Non-BulkItemFailure rejection from the UPDATE. */
  updateFailWith: Error | null;
  /** Reject the Nth (0-based) consent insert. */
  insertFailAt: number | null;
  insertCalls: number;
} = {
  baseRow: null,
  rowQueue: undefined,
  updates: [],
  inserted: [],
  updateReturnsNoRow: false,
  updateFailWith: null,
  insertFailAt: null,
  insertCalls: 0,
};

vi.mock('@/services/consent_version', () => ({
  resolveConsentVersion: vi.fn(async () => 1),
}));

vi.mock('@/services/guardian_action_gate', () => ({
  guardianActionGate: vi.fn(async () => ({ status: 'not_required' })),
  guardianBulkActionGate: vi.fn(async () => new Map()),
  guardianGateFailure: vi.fn(() => null),
}));

vi.mock('@/notifications/notify_actions', () => ({
  dispatchActionNotifications: vi.fn(async () => undefined),
}));

vi.mock('@api/db/postgres/drizzle_config', () => {
  const dbMock: Record<string, unknown> = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            const row = dbState.rowQueue
              ? (dbState.rowQueue.shift() ?? null)
              : dbState.baseRow;
            return Promise.resolve(row ? [row] : []);
          }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => {
            if (dbState.updateFailWith) return Promise.reject(dbState.updateFailWith);
            dbState.updates.push(values);
            if (dbState.updateReturnsNoRow) return Promise.resolve([]);
            return Promise.resolve([{ ...(dbState.baseRow ?? {}), ...values }]);
          }),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        const call = dbState.insertCalls++;
        if (dbState.insertFailAt === call) {
          return Promise.reject(new Error('consent_record unique violation'));
        }
        dbState.inserted.push(row);
        return Promise.resolve(undefined);
      }),
    })),
  };
  dbMock.transaction = vi.fn(async (cb: (tx: unknown) => unknown) => cb(dbMock));
  return { db: dbMock };
});

vi.mock('@dpg/database', async () => {
  const actual = await vi.importActual<typeof import('@dpg/database')>('@dpg/database');
  return { ...actual, ensureActionEventPartition: vi.fn(async () => undefined) };
});

vi.mock('@/utils/action_event_runtime', async () => {
  const actual =
    await vi.importActual<typeof import('@/utils/action_event_runtime')>(
      '@/utils/action_event_runtime',
    );
  return {
    ...actual,
    buildActionEventPayload: vi.fn(() => ({})),
    validateActionEventPayload: vi.fn(),
    insertActionEvent: vi.fn(async () => ({ event_id: 'evt_1' })),
    mirrorActionEventToSourceInstance: vi.fn(() => undefined),
    fetchLocalItemSnapshot: vi.fn(async () => ({
      created_by: 'usr_snapshot_owner',
      item_id: 'target_item_1',
      item_locations: [],
      private_state: {},
      lifecycle_status: 'live',
    })),
  };
});

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({
    domains: [{ id: 'provider' }],
    instances: [{ domain_id: 'provider', instance_url: 'http://target.local' }],
  })),
}));

vi.mock('@dpg/schemas', async () => {
  const actual = await vi.importActual<typeof import('@dpg/schemas')>('@dpg/schemas');
  return {
    ...actual,
    getActionInteraction: vi.fn(() => ({ event_schema: {}, reveals_pii_on_status: [] })),
  };
});

// Imported after the mocks.
import { update_action_status } from '../update_action_status.js';
import { BulkItemFailure } from '@/utils/bulk_runner';
import {
  guardianActionGate,
  guardianBulkActionGate,
  guardianGateFailure,
} from '@/services/guardian_action_gate';
import { getActionInteraction } from '@dpg/schemas';
import { getNetworkConfigById } from '@/network_configs';
import { resolveConsentVersion } from '@/services/consent_version';
import { ensureActionEventPartition } from '@dpg/database';
import {
  fetchLocalItemSnapshot,
  insertActionEvent,
  validateActionEventPayload,
} from '@/utils/action_event_runtime';

const TARGET_OWNER = 'usr_target_owner';

const EXISTING_ACTION = {
  action_id: KNOWN_ACTION_ID,
  action_type: 'apply',
  action_status: 'created',
  update_count: 0,
  remarks: 'original remark',
  source_item_network: 'blue_dot',
  source_item_domain: 'seeker',
  source_item_type: 'profile_1.0',
  source_item_id: '11111111-1111-4111-8111-111111111111',
  source_item_instance_url: 'http://source.local',
  source_item_owner: 'usr_seeker',
  target_item_network: 'blue_dot',
  target_item_domain: 'provider',
  target_item_type: 'job_posting_1.0',
  target_item_id: '22222222-2222-4222-8222-222222222222',
  target_item_instance_url: 'http://target.local',
  target_item_owner: TARGET_OWNER,
  requirements_snapshot: {},
  performed_by_org_id: null,
  performed_by_service_user_id: null,
};

const LIVE_SNAPSHOT = {
  created_by: 'usr_snapshot_owner',
  item_id: 'target_item_1',
  item_locations: [],
  private_state: {},
  lifecycle_status: 'live',
};

/** Interaction whose `accepted` status reveals PII → the consent/U18 gate arms. */
const GATED_INTERACTION = { event_schema: {}, reveals_pii_on_status: ['accepted'] };

const ACCEPT_BODY = {
  action_id: KNOWN_ACTION_ID,
  action_status: 'accepted',
  consent: { acknowledged: true, version: 1 },
};

// Untyped mock handles: the real signatures are far wider than these fixtures,
// and casting each fixture to the full type buys nothing for these assertions.
const interactionMock = getActionInteraction as unknown as ReturnType<typeof vi.fn>;
const snapshotMock = fetchLocalItemSnapshot as unknown as ReturnType<typeof vi.fn>;

const buildApp = (
  request_user: { id: string } = { id: TARGET_OWNER },
  acting_org?: unknown,
): FastifyInstance => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { user: typeof request_user }).user = request_user;
    if (acting_org) (req as unknown as { acting_org: unknown }).acting_org = acting_org;
  });
  app.register(update_action_status);
  return app;
};

const post = (payload: unknown[], user?: { id: string }, acting_org?: unknown) =>
  buildApp(user, acting_org).inject({ method: 'POST', url: '/update-status', payload });

describe('POST /api/v1/action/update-status — uncovered branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.baseRow = { ...EXISTING_ACTION };
    dbState.rowQueue = undefined;
    dbState.updates = [];
    dbState.inserted = [];
    dbState.updateReturnsNoRow = false;
    dbState.updateFailWith = null;
    dbState.insertFailAt = null;
    dbState.insertCalls = 0;

    // Re-arm the defaults cleared by clearAllMocks().
    interactionMock.mockReturnValue({ event_schema: {}, reveals_pii_on_status: [] });
    snapshotMock.mockResolvedValue({ ...LIVE_SNAPSHOT });
    vi.mocked(guardianActionGate).mockResolvedValue({ status: 'not_required' });
    vi.mocked(guardianBulkActionGate).mockResolvedValue(new Map());
    vi.mocked(guardianGateFailure).mockReturnValue(null);
    vi.mocked(resolveConsentVersion).mockResolvedValue(1);
    vi.mocked(ensureActionEventPartition).mockResolvedValue(undefined);
    vi.mocked(insertActionEvent).mockResolvedValue({
      event_id: 'evt_1',
    } as unknown as Awaited<ReturnType<typeof insertActionEvent>>);
    vi.mocked(getNetworkConfigById).mockResolvedValue({
      domains: [{ id: 'provider' }],
      instances: [{ domain_id: 'provider', instance_url: 'http://target.local' }],
    } as unknown as Awaited<ReturnType<typeof getNetworkConfigById>>);
  });

  describe('per-item validation and event failures', () => {
    it('422 INVALID_PAYLOAD with the zod path in the message when a row is malformed', async () => {
      const res = await post([{ action_id: 'not-a-uuid', action_status: '' }]);

      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ error: 'INVALID_PAYLOAD' });
      expect(res.json().results[0].message).toContain('action_id');
      expect(res.json().results[0].message).toContain('action_status');
      expect(dbState.updates).toHaveLength(0);
    });

    it('422 INVALID_ACTION_EVENT surfacing the getActionInteraction error message', async () => {
      interactionMock.mockImplementation(() => {
        throw new Error('no interaction declared for apply');
      });

      const res = await post([{ action_id: KNOWN_ACTION_ID, action_status: 'shortlisted' }]);

      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({
        error: 'INVALID_ACTION_EVENT',
        message: 'no interaction declared for apply',
      });
      expect(dbState.updates).toHaveLength(0);
    });

    it('422 INVALID_ACTION_EVENT when the built event payload fails schema validation', async () => {
      vi.mocked(validateActionEventPayload).mockImplementationOnce(() => {
        throw new Error('event payload missing status');
      });

      const res = await post([{ action_id: KNOWN_ACTION_ID, action_status: 'shortlisted' }]);

      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({
        error: 'INVALID_ACTION_EVENT',
        message: 'event payload missing status',
      });
      expect(dbState.updates).toHaveLength(0);
    });

    it('422 PARTITION_SETUP_FAILED when the action-event partition cannot be ensured', async () => {
      vi.mocked(ensureActionEventPartition).mockRejectedValueOnce(new Error('no ddl privilege'));

      const res = await post([{ action_id: KNOWN_ACTION_ID, action_status: 'shortlisted' }]);

      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ error: 'PARTITION_SETUP_FAILED' });
      // Storage prep fails before any write is attempted.
      expect(dbState.updates).toHaveLength(0);
    });

    it('422 ACTION_CONFLICT when the optimistic update_count guard matches no row', async () => {
      dbState.updateReturnsNoRow = true;

      const res = await post([{ action_id: KNOWN_ACTION_ID, action_status: 'shortlisted' }]);

      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ error: 'ACTION_CONFLICT' });
      expect(vi.mocked(insertActionEvent)).not.toHaveBeenCalled();
    });

    it('422 INTERNAL_SERVER_ERROR (not CONSENT_WRITE_FAILED) when the UPDATE itself rejects', async () => {
      dbState.updateFailWith = new Error('connection terminated');

      const res = await post([{ action_id: KNOWN_ACTION_ID, action_status: 'shortlisted' }]);

      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred.',
      });
    });
  });

  describe('liveness of the counterparty (source) item', () => {
    it('422 PROFILE_NOT_LIVE when the local source item is not live', async () => {
      // Target snapshot resolves live, the source (same instance) is paused.
      snapshotMock
        .mockResolvedValueOnce({ ...LIVE_SNAPSHOT })
        .mockResolvedValueOnce({ ...LIVE_SNAPSHOT, lifecycle_status: 'paused' });

      const res = await post([{ action_id: KNOWN_ACTION_ID, action_status: 'shortlisted' }]);

      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({
        error: 'PROFILE_NOT_LIVE',
        message: 'source_item is not live; status updates blocked',
      });
      expect(dbState.updates).toHaveLength(0);
    });

    it('skips the source liveness check and the source snapshot when the source lives off-instance', async () => {
      dbState.baseRow = {
        ...EXISTING_ACTION,
        source_item_instance_url: 'http://other.local',
      };

      const res = await post([{ action_id: KNOWN_ACTION_ID, action_status: 'shortlisted' }]);

      expect(res.statusCode).toBe(200);
      // Only the target snapshot pre-check + the post-commit target read.
      expect(snapshotMock).toHaveBeenCalledTimes(2);
      expect(vi.mocked(insertActionEvent).mock.calls[0][1]).toMatchObject({
        source_item_owner: 'usr_seeker',
        source_item_locations: [],
      });
    });

    it('falls back to the snapshot creator when the row carries no source_item_owner', async () => {
      dbState.baseRow = { ...EXISTING_ACTION, source_item_owner: null };

      const res = await post([{ action_id: KNOWN_ACTION_ID, action_status: 'shortlisted' }]);

      expect(res.statusCode).toBe(200);
      expect(vi.mocked(insertActionEvent).mock.calls[0][1]).toMatchObject({
        source_item_owner: 'usr_snapshot_owner',
      });
      // No remarks on the body → the existing remark is preserved.
      expect(dbState.updates[0]).toMatchObject({ remarks: 'original remark' });
    });
  });

  describe('accept-consent write failures roll the status change back', () => {
    it('422 CONSENT_WRITE_FAILED when no accept consent version is configured', async () => {
      interactionMock.mockReturnValue({ ...GATED_INTERACTION });
      vi.mocked(resolveConsentVersion).mockResolvedValueOnce(null);

      const res = await post([ACCEPT_BODY]);

      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({
        error: 'CONSENT_WRITE_FAILED',
        message: 'Failed to record consent; the status change was not applied.',
      });
      expect(dbState.inserted).toHaveLength(0);
      expect(vi.mocked(insertActionEvent)).not.toHaveBeenCalled();
    });

    it('422 CONSENT_WRITE_FAILED when the adult consent_record insert rejects', async () => {
      interactionMock.mockReturnValue({ ...GATED_INTERACTION });
      dbState.insertFailAt = 0;

      const res = await post([ACCEPT_BODY]);

      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ error: 'CONSENT_WRITE_FAILED' });
      expect(vi.mocked(insertActionEvent)).not.toHaveBeenCalled();
    });
  });

  describe('U18 verified accept writes the guardian consent row', () => {
    it('writes both the adult action row and the guardian u18 row on a verified gate', async () => {
      interactionMock.mockReturnValue({ ...GATED_INTERACTION });
      vi.mocked(guardianActionGate).mockResolvedValue({ status: 'verified' });

      const res = await post([{ ...ACCEPT_BODY, guardian_otp: '123456' }]);

      expect(res.statusCode).toBe(200);
      expect(vi.mocked(guardianActionGate)).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'accept',
          channel: 'self',
          otp: '123456',
          wardUserId: TARGET_OWNER,
          // The accepting minor's own item is the SOURCE of the gate scope.
          sourceItemId: EXISTING_ACTION.target_item_id,
          targetItemId: EXISTING_ACTION.source_item_id,
        }),
      );
      expect(dbState.inserted).toHaveLength(2);
      expect(dbState.inserted[0]).toMatchObject({
        consentCategory: 'action',
        source: 'action',
        userId: TARGET_OWNER,
        itemId: EXISTING_ACTION.target_item_id,
      });
      expect(dbState.inserted[1]).toMatchObject({
        consentCategory: 'action',
        source: 'guardian',
        userId: TARGET_OWNER,
        metadata: { variant: 'u18' },
      });
    });

    it('422 CONSENT_WRITE_FAILED when the guardian accept version is unconfigured', async () => {
      interactionMock.mockReturnValue({ ...GATED_INTERACTION });
      vi.mocked(guardianActionGate).mockResolvedValue({ status: 'verified' });
      // First resolve = adult accept row, second = guardian row.
      vi.mocked(resolveConsentVersion)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(null);

      const res = await post([{ ...ACCEPT_BODY, guardian_otp: '123456' }]);

      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ error: 'CONSENT_WRITE_FAILED' });
      expect(dbState.inserted).toHaveLength(1);
      expect(vi.mocked(insertActionEvent)).not.toHaveBeenCalled();
    });

    it('422 CONSENT_WRITE_FAILED when the guardian consent insert rejects', async () => {
      interactionMock.mockReturnValue({ ...GATED_INTERACTION });
      vi.mocked(guardianActionGate).mockResolvedValue({ status: 'verified' });
      dbState.insertFailAt = 1;

      const res = await post([{ ...ACCEPT_BODY, guardian_otp: '123456' }]);

      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ error: 'CONSENT_WRITE_FAILED' });
      expect(vi.mocked(insertActionEvent)).not.toHaveBeenCalled();
    });

    it('still passes channel "self" when an acting_org is present (#395 fail-closed invariant)', async () => {
      interactionMock.mockReturnValue({ ...GATED_INTERACTION });
      vi.mocked(guardianActionGate).mockResolvedValue({ status: 'external_minor_blocked', reason: 'minor' });
      vi.mocked(guardianGateFailure).mockReturnValueOnce(
        new BulkItemFailure('MINOR_ACTION_CHANNEL_BLOCKED', 'blocked'),
      );

      const res = await post([ACCEPT_BODY], { id: TARGET_OWNER }, { org_id: 'org_1' });

      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ error: 'MINOR_ACTION_CHANNEL_BLOCKED' });
      expect(vi.mocked(guardianActionGate)).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'self' }),
      );
      expect(dbState.updates).toHaveLength(0);
    });
  });

  describe('bulk accept pre-pass (one guardian OTP per batch, #393)', () => {
    it('batches every gated row and uses the batch result instead of the per-item gate', async () => {
      interactionMock.mockReturnValue({ ...GATED_INTERACTION });
      vi.mocked(guardianBulkActionGate).mockResolvedValue(
        new Map([
          [0, { status: 'verified' as const }],
          [1, { status: 'verified' as const }],
        ]),
      );
      const secondRow = { ...EXISTING_ACTION, action_id: OTHER_ACTION_ID };
      dbState.rowQueue = [
        { ...EXISTING_ACTION },
        secondRow,
        { ...EXISTING_ACTION },
        secondRow,
      ];

      const res = await post([
        ACCEPT_BODY,
        // The single batch OTP is read from whichever row carries it.
        { ...ACCEPT_BODY, action_id: OTHER_ACTION_ID, guardian_otp: '654321' },
      ]);

      expect(res.statusCode).toBe(200);
      expect(vi.mocked(guardianBulkActionGate)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(guardianBulkActionGate)).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'accept', otp: '654321' }),
      );
      expect(vi.mocked(guardianBulkActionGate).mock.calls[0][0].items).toEqual([
        expect.objectContaining({
          index: 0,
          wardUserId: TARGET_OWNER,
          sourceItemId: EXISTING_ACTION.target_item_id,
          targetItemId: EXISTING_ACTION.source_item_id,
        }),
        expect.objectContaining({ index: 1 }),
      ]);
      // Batch result consumed → the per-item gate is never consulted.
      expect(vi.mocked(guardianActionGate)).not.toHaveBeenCalled();
      // 2 adult rows + 2 guardian rows.
      expect(dbState.inserted).toHaveLength(4);
    });

    it('reports the batch gate failure per item without committing any row', async () => {
      interactionMock.mockReturnValue({ ...GATED_INTERACTION });
      vi.mocked(guardianBulkActionGate).mockResolvedValue(
        new Map([
          [0, { status: 'challenge_issued' as const }],
          [1, { status: 'challenge_issued' as const }],
        ]),
      );
      vi.mocked(guardianGateFailure).mockReturnValue(
        new BulkItemFailure('GUARDIAN_OTP_REQUIRED', 'Guardian OTP sent'),
      );

      const res = await post([ACCEPT_BODY, ACCEPT_BODY]);

      expect(res.statusCode).toBe(422);
      expect(res.json().summary).toMatchObject({ total: 2, succeeded: 0, failed: 2 });
      expect(res.json().results.map((r: { error: string }) => r.error)).toEqual([
        'GUARDIAN_OTP_REQUIRED',
        'GUARDIAN_OTP_REQUIRED',
      ]);
      expect(dbState.updates).toHaveLength(0);
    });

    it('skips unparseable rows, unknown actions and non-gated statuses when building the batch', async () => {
      // Row 0: unparseable. Row 1: action not found. Row 2: gated accept.
      // The lookup order is pre-pass rows 1,2 then main-loop rows 1,2.
      dbState.rowQueue = [null, { ...EXISTING_ACTION }, null, { ...EXISTING_ACTION }];
      interactionMock.mockReturnValue({ ...GATED_INTERACTION });
      vi.mocked(guardianBulkActionGate).mockResolvedValue(
        new Map([[2, { status: 'not_required' as const }]]),
      );

      const res = await post([
        { action_id: 'nope' },
        { action_id: OTHER_ACTION_ID, action_status: 'accepted' },
        ACCEPT_BODY,
      ]);

      expect(res.statusCode).toBe(207);
      expect(res.json().results.map((r: { error?: string }) => r.error)).toEqual([
        'INVALID_PAYLOAD',
        'ACTION_NOT_FOUND',
        undefined,
      ]);
      expect(vi.mocked(guardianBulkActionGate).mock.calls[0][0].items).toEqual([
        expect.objectContaining({ index: 2 }),
      ]);
    });

    it('does not call the batch gate at all when no row is consent-gated', async () => {
      const res = await post([
        { action_id: KNOWN_ACTION_ID, action_status: 'shortlisted' },
        { action_id: KNOWN_ACTION_ID, action_status: 'shortlisted' },
      ]);

      expect(res.statusCode).toBe(200);
      expect(vi.mocked(guardianBulkActionGate)).not.toHaveBeenCalled();
      expect(dbState.updates).toHaveLength(2);
    });

    it('skips rows the caller does not own as the target (only the accepting party is batched)', async () => {
      interactionMock.mockReturnValue({ ...GATED_INTERACTION });

      const res = await post([ACCEPT_BODY, ACCEPT_BODY], { id: 'usr_seeker' });

      expect(vi.mocked(guardianBulkActionGate)).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(422);
      expect(res.json().results.map((r: { error: string }) => r.error)).toEqual([
        'NOT_TARGET_ITEM_OWNER',
        'NOT_TARGET_ITEM_OWNER',
      ]);
    });

    it('skips a row whose network config cannot be loaded, leaving it to the per-item handler', async () => {
      interactionMock.mockReturnValue({ ...GATED_INTERACTION });
      // Pre-pass load throws; the main loop then reports INVALID_ACTION_EVENT.
      vi.mocked(getNetworkConfigById).mockRejectedValue(new Error('network config unavailable'));

      const res = await post([ACCEPT_BODY, ACCEPT_BODY]);

      expect(vi.mocked(guardianBulkActionGate)).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({
        error: 'INVALID_ACTION_EVENT',
        message: 'network config unavailable',
      });
    });

    it('falls back to the per-item gate when the pre-pass itself throws (fail-safe)', async () => {
      interactionMock.mockReturnValue({ ...GATED_INTERACTION });
      vi.mocked(guardianBulkActionGate).mockRejectedValue(new Error('redis down'));

      const res = await post([ACCEPT_BODY, ACCEPT_BODY]);

      expect(res.statusCode).toBe(200);
      expect(vi.mocked(guardianActionGate)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(guardianActionGate)).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'accept', channel: 'self' }),
      );
    });

    it('uses the per-item gate for a single-row submit (no batch pre-pass)', async () => {
      interactionMock.mockReturnValue({ ...GATED_INTERACTION });

      const res = await post([ACCEPT_BODY]);

      expect(res.statusCode).toBe(200);
      expect(vi.mocked(guardianBulkActionGate)).not.toHaveBeenCalled();
      expect(vi.mocked(guardianActionGate)).toHaveBeenCalledTimes(1);
    });
  });
});
