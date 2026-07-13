import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

// Mutable peerConfig mock — each test sets auth_mode. Hoisted so the vi.mock
// factory (also hoisted) can reference it.
const { peerConfig } = vi.hoisted(() => ({
  peerConfig: {
    shared_secret: 'c'.repeat(48),
    auth_mode: 'permissive' as 'permissive' | 'enforced',
    token_window_seconds: 300,
  },
}));
vi.mock('@/config', () => ({ peerConfig }));

import { peer_instance_guard } from '../peer_instance_guard.js';
import {
  buildPeerHeaders,
  INSTANCE_TOKEN_HEADER,
  INSTANCE_TIMESTAMP_HEADER,
} from '@/utils/instance_token.js';

const PATH = '/api/v1/network/item/count_local';
const BODY = { item_network: 'blue_dot', item_domain: 'student' };

const makeReply = () => {
  const reply = {
    code: vi.fn(function (this: unknown) {
      return this;
    }),
    send: vi.fn(function (this: unknown) {
      return this;
    }),
  };
  return reply as unknown as FastifyReply & {
    code: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
};

const makeRequest = (
  headers: Record<string, string> = {},
  body: unknown = BODY
): FastifyRequest =>
  ({
    url: PATH,
    body,
    headers,
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  }) as unknown as FastifyRequest;

const validHeaders = () => buildPeerHeaders(PATH, JSON.stringify(BODY));

beforeEach(() => {
  peerConfig.auth_mode = 'permissive';
});

describe('peer_instance_guard', () => {
  it('enforced + no token → 401 PEER_AUTH_FAILED', async () => {
    peerConfig.auth_mode = 'enforced';
    const reply = makeReply();
    await peer_instance_guard(makeRequest(), reply);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PEER_AUTH_FAILED' })
    );
  });

  it('enforced + valid signed headers → passes (no reply)', async () => {
    peerConfig.auth_mode = 'enforced';
    const reply = makeReply();
    const result = await peer_instance_guard(makeRequest(validHeaders()), reply);
    expect(result).toBeUndefined();
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('permissive + no token → passes (allowed, warns)', async () => {
    const reply = makeReply();
    const req = makeRequest();
    await peer_instance_guard(req, reply);
    expect(reply.code).not.toHaveBeenCalled();
    expect((req.log.warn as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('permissive + present-but-bad token → 401 (rejects invalid even in permissive)', async () => {
    const reply = makeReply();
    const headers = validHeaders();
    headers[INSTANCE_TOKEN_HEADER] = 'deadbeef'; // wrong signature, present
    await peer_instance_guard(makeRequest(headers), reply);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('enforced + tampered body vs signed token → 401 (M2 body binding)', async () => {
    peerConfig.auth_mode = 'enforced';
    const reply = makeReply();
    // sign for the real body, then deliver a different body
    const headers = validHeaders();
    await peer_instance_guard(
      makeRequest(headers, { item_network: 'blue_dot', item_domain: 'provider' }),
      reply
    );
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('timestamp header alone without token → 401 in enforced', async () => {
    peerConfig.auth_mode = 'enforced';
    const reply = makeReply();
    await peer_instance_guard(
      makeRequest({ [INSTANCE_TIMESTAMP_HEADER]: '1000000' }),
      reply
    );
    expect(reply.code).toHaveBeenCalledWith(401);
  });
});
