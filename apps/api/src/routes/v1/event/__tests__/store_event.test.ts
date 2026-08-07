import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
const {
  isServedDomainBinding,
  replyForUnservedDomain,
  getNetworkConfigById,
  getActionInteraction,
  validateActionEventPayload,
  ensureActionEventPartition,
  insertActionEvent,
} = vi.hoisted(() => ({
  isServedDomainBinding: vi.fn(),
  replyForUnservedDomain: vi.fn(),
  getNetworkConfigById: vi.fn(),
  getActionInteraction: vi.fn(),
  validateActionEventPayload: vi.fn(),
  ensureActionEventPartition: vi.fn(),
  insertActionEvent: vi.fn(),
}));

vi.mock('@api/db/postgres/drizzle_config', () => ({ db: {} }));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));

vi.mock('@dpg/schemas', () => ({
  default: {
    object: () => ({}),
    string: () => ({ nullable: () => ({}) }),
    number: () => ({ int: () => ({ nonnegative: () => ({}) }) }),
  },
  getActionInteraction: (...a: unknown[]) => getActionInteraction(...a),
  StoreEventBodySchema: {},
}));

vi.mock('@dpg/database', () => ({
  ensureActionEventPartition: (...a: unknown[]) =>
    ensureActionEventPartition(...a),
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: (...a: unknown[]) => getNetworkConfigById(...a),
}));

vi.mock('@/utils/served_domain_guard', () => ({
  isServedDomainBinding: (...a: unknown[]) => isServedDomainBinding(...a),
  replyForUnservedDomain: (...a: unknown[]) => replyForUnservedDomain(...a),
}));

vi.mock('@/utils/action_event_runtime', () => ({
  insertActionEvent: (...a: unknown[]) => insertActionEvent(...a),
  validateActionEventPayload: (...a: unknown[]) =>
    validateActionEventPayload(...a),
}));

import { store_event_handler } from '../store_event';

interface FakeReply {
  statusCode: number;
  body: unknown;
  code(c: number): FakeReply;
  send(b: unknown): FakeReply;
}

function makeReply(): FakeReply {
  return {
    statusCode: 0,
    body: undefined,
    code(c) {
      this.statusCode = c;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
  };
}

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    action_id: 'a1',
    action_type: 'apply',
    action_status: 'submitted',
    update_count: 0,
    source_item: {
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
    },
    target_item: {
      item_network: 'blue_dot',
      item_domain: 'provider',
      item_type: 'post_1.0',
    },
    event_payload: { note: 'hi' },
    ...overrides,
  };
}

const log = { error: vi.fn() };

function call(body: Record<string, unknown>) {
  const reply = makeReply();
  return store_event_handler(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { body, log } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reply as any,
  ).then(() => reply);
}

describe('store_event_handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isServedDomainBinding.mockReturnValue(true);
    getNetworkConfigById.mockResolvedValue({ id: 'blue_dot' });
    getActionInteraction.mockReturnValue({ event_schema: { type: 'object' } });
    validateActionEventPayload.mockReturnValue(undefined);
    ensureActionEventPartition.mockResolvedValue(undefined);
    insertActionEvent.mockResolvedValue({ event_id: 'e1' });
  });

  it('delegates to the unserved-domain reply when the source binding is not served', async () => {
    isServedDomainBinding.mockReturnValue(false);

    await call(makeBody());

    expect(replyForUnservedDomain).toHaveBeenCalledWith(
      expect.anything(),
      'blue_dot',
      'seeker',
    );
    // Nothing is persisted when the binding is rejected.
    expect(insertActionEvent).not.toHaveBeenCalled();
  });

  it('201 with the created event id on the happy path', async () => {
    const reply = await call(makeBody());

    expect(reply.statusCode).toBe(201);
    expect(reply.body).toEqual({
      event_id: 'e1',
      action_id: 'a1',
      action_type: 'apply',
      action_status: 'submitted',
      update_count: 0,
    });
  });

  it('reports a null event_id when the insert returns nothing', async () => {
    insertActionEvent.mockResolvedValue(undefined);

    const reply = await call(makeBody());

    expect(reply.statusCode).toBe(201);
    expect((reply.body as { event_id: string | null }).event_id).toBeNull();
  });

  it('400 INVALID_EVENT_REQUEST when the interaction lookup throws', async () => {
    getActionInteraction.mockImplementation(() => {
      throw new Error('no such interaction');
    });

    const reply = await call(makeBody());

    expect(reply.statusCode).toBe(400);
    expect(reply.body).toEqual({
      error: 'INVALID_EVENT_REQUEST',
      message: 'no such interaction',
    });
  });

  it('400 INVALID_EVENT_REQUEST when the payload fails event-schema validation', async () => {
    validateActionEventPayload.mockImplementation(() => {
      throw new Error('payload does not match event_schema');
    });

    const reply = await call(makeBody());

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { message: string }).message).toBe(
      'payload does not match event_schema',
    );
  });

  it('400 with a generic message when a non-Error is thrown', async () => {
    getActionInteraction.mockImplementation(() => {
      throw 'a bare string';
    });

    const reply = await call(makeBody());

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { message: string }).message).toBe(
      'Invalid event request',
    );
  });

  it('500 PARTITION_SETUP_FAILED when the partition cannot be ensured', async () => {
    ensureActionEventPartition.mockRejectedValue(new Error('ddl blew up'));

    const reply = await call(makeBody());

    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({
      error: 'PARTITION_SETUP_FAILED',
      message: 'Failed to prepare storage for event type',
    });
    // The failure is logged with context for operators.
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(insertActionEvent).not.toHaveBeenCalled();
  });

  it('resolves the interaction against the TARGET network config', async () => {
    await call(makeBody());

    // The event schema lives on the target network's interaction definition.
    expect(getNetworkConfigById).toHaveBeenCalledWith('blue_dot');
    expect(getActionInteraction).toHaveBeenCalledWith(
      { id: 'blue_dot' },
      expect.objectContaining({
        actionType: 'apply',
        fromDomain: 'seeker',
        toDomain: 'provider',
      }),
    );
  });

  it('partitions the event by the SOURCE network and action type', async () => {
    await call(makeBody());

    // Partition pruning contract: keyed on item_network + action_type.
    expect(ensureActionEventPartition).toHaveBeenCalledWith(
      {},
      'blue_dot',
      'apply',
    );
  });

  it('echoes a non-zero update_count back to the caller', async () => {
    const reply = await call(makeBody({ update_count: 4 }));

    expect((reply.body as { update_count: number }).update_count).toBe(4);
  });
});
