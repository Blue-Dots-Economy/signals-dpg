import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply } from 'fastify';

// vi.mock factories — hoisted so they run before the handler import below.
const selectResults: {
  user: Array<{ id: string }>;
  consent_record: Array<{ consentCategory: string; documentVersion: number }>;
} = { user: [], consent_record: [] };

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        // Handler calls `.where(...).limit(1)` for the user lookup, and
        // `.where(...)` (awaited directly, no `.limit()`) for consent rows —
        // `limit` returns the user fixture, the bare thenable serves the
        // consent-record fixture, matching each call site's actual chain shape.
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(selectResults.user)),
          then: (resolve: (rows: unknown[]) => unknown) =>
            resolve(selectResults.consent_record),
        })),
      })),
    })),
  },
}));

vi.mock('@dpg/auth', () => ({
  getPiiKey: vi.fn(() => Buffer.from('0'.repeat(64), 'hex')),
}));

import { get_consent_status_by_identifier_handler } from '../get_consent_status_by_identifier.js';

const makeReply = () => {
  const reply: Record<string, unknown> = {
    code: vi.fn(function (this: unknown) {
      return this;
    }),
    send: vi.fn(function (this: unknown) {
      return this;
    }),
  };
  return reply as unknown as FastifyReply;
};

const makeRequest = (query: { network: string; email?: string; phone?: string }) => {
  const log = { info: vi.fn(), error: vi.fn() };
  return { query, log } as any;
};

describe('get_consent_status_by_identifier_handler — audit logging (#4/#14)', () => {
  beforeEach(() => {
    selectResults.user = [];
    selectResults.consent_record = [];
  });

  it('logs a hashed identifier, never the raw email, when no user is found', async () => {
    const request = makeRequest({ network: 'blue_dot', email: 'alice@example.com' });
    const reply = makeReply();

    await get_consent_status_by_identifier_handler(request, reply);

    expect(request.log.info).toHaveBeenCalledTimes(1);
    const [logPayload] = request.log.info.mock.calls[0];
    expect(logPayload.found).toBe(false);
    expect(logPayload.network).toBe('blue_dot');
    expect(logPayload.identifierHash).toBeTypeOf('string');
    expect(logPayload.identifierHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(logPayload)).not.toContain('alice@example.com');
  });

  it('logs found:true and a hashed identifier when a matching user exists', async () => {
    selectResults.user = [{ id: 'user-1' }];
    selectResults.consent_record = [{ consentCategory: 'terms', documentVersion: 1 }];

    const request = makeRequest({ network: 'blue_dot', phone: '+919999999999' });
    const reply = makeReply();

    await get_consent_status_by_identifier_handler(request, reply);

    expect(request.log.info).toHaveBeenCalledTimes(1);
    const [logPayload] = request.log.info.mock.calls[0];
    expect(logPayload.found).toBe(true);
    expect(JSON.stringify(logPayload)).not.toContain('+919999999999');
  });

  it('produces a deterministic hash for the same identifier and a different one for a different identifier', async () => {
    const requestA = makeRequest({ network: 'blue_dot', email: 'bob@example.com' });
    const requestB = makeRequest({ network: 'blue_dot', email: 'bob@example.com' });
    const requestC = makeRequest({ network: 'blue_dot', email: 'carol@example.com' });

    await get_consent_status_by_identifier_handler(requestA, makeReply());
    await get_consent_status_by_identifier_handler(requestB, makeReply());
    await get_consent_status_by_identifier_handler(requestC, makeReply());

    const hashA = requestA.log.info.mock.calls[0][0].identifierHash;
    const hashB = requestB.log.info.mock.calls[0][0].identifierHash;
    const hashC = requestC.log.info.mock.calls[0][0].identifierHash;

    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(hashC);
  });
});
