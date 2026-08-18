import { vi } from 'vitest';
import type { BetterAuthPlugin } from 'better-auth/types';

/**
 * Test doubles for the slice of better-auth's endpoint context the
 * `unified-otp` plugin touches: the Drizzle-backed `adapter`, the Redis-backed
 * `secondaryStorage`, and `internalAdapter.createSession`.
 *
 * The endpoints are plain `better-call` handlers, so they can be invoked
 * directly with `{ body, context }` — `createInternalContext` validates the
 * body against the endpoint's Zod schema and passes `context` through as
 * `ctx.context`, which is exactly what these fakes stand in for.
 */

export type FakeRow = Record<string, unknown>;
type Where = { field: string; value: unknown }[];

export interface FakeContextOptions {
  users?: FakeRow[];
  organizations?: FakeRow[];
  members?: FakeRow[];
  /** Pre-seeded OTP storage, keyed exactly as the plugin keys it. */
  storedOtps?: Record<string, string>;
  /** When set, `internalAdapter.createSession` rejects with this error. */
  createSessionError?: Error;
}

const matches = (row: FakeRow, where: Where): boolean =>
  where.every((clause) => row[clause.field] === clause.value);

export function createFakeAuthContext(options: FakeContextOptions = {}) {
  const tables: Record<string, FakeRow[]> = {
    user: options.users ?? [],
    organization: options.organizations ?? [],
    member: options.members ?? [],
  };

  const store = new Map<string, string>(
    Object.entries(options.storedOtps ?? {})
  );
  /** Last TTL (seconds) each key was written with. */
  const ttls = new Map<string, number | undefined>();
  let idCounter = 0;

  const findOne = vi.fn(async (args: { model: string; where: Where }) => {
    const rows = tables[args.model] ?? [];
    return rows.find((row) => matches(row, args.where)) ?? null;
  });

  const create = vi.fn(async (args: { model: string; data: FakeRow }) => {
    idCounter += 1;
    const row: FakeRow = { id: `${args.model}_${idCounter}`, ...args.data };
    (tables[args.model] ??= []).push(row);
    return row;
  });

  const update = vi.fn(
    async (args: { model: string; where: Where; update: FakeRow }) => {
      const row = (tables[args.model] ?? []).find((candidate) =>
        matches(candidate, args.where)
      );
      if (!row) return null;
      Object.assign(row, args.update);
      return row;
    }
  );

  const secondaryStorage = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ttl?: number) => {
      store.set(key, value);
      ttls.set(key, ttl);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };

  const createSession = vi.fn(
    async (userId: string, dontRememberMe?: boolean) => {
      if (options.createSessionError) throw options.createSessionError;
      return {
        id: 'session_1',
        token: `token_for_${userId}`,
        userId,
        dontRememberMe: dontRememberMe ?? false,
        expiresAt: new Date(Date.now() + 60_000),
      };
    }
  );

  const setNewSession = vi.fn();

  const context = {
    adapter: { findOne, create, update },
    internalAdapter: { createSession },
    secondaryStorage,
    setNewSession,
    options: {},
  };

  return {
    context,
    tables,
    store,
    ttls,
    findOne,
    create,
    update,
    secondaryStorage,
    createSession,
    setNewSession,
  };
}

export type OtpEndpointName = 'checkUser' | 'requestOtp' | 'verifyOtp';

/** Invoke one of the plugin's endpoints with a body and a fake auth context. */
export function callEndpoint(
  plugin: BetterAuthPlugin,
  name: OtpEndpointName,
  body: Record<string, unknown>,
  context: unknown
): Promise<Record<string, unknown>> {
  const endpoints = plugin.endpoints as unknown as Record<
    string,
    (ctx: { body: Record<string, unknown>; context: unknown }) => Promise<
      Record<string, unknown>
    >
  >;
  return endpoints[name]({ body, context });
}

/** The declared path of an endpoint, as better-auth mounts it. */
export function endpointPath(
  plugin: BetterAuthPlugin,
  name: OtpEndpointName
): string {
  const endpoints = plugin.endpoints as unknown as Record<
    string,
    { path: string }
  >;
  return endpoints[name].path;
}
