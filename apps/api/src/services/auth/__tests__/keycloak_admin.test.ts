import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  KeycloakAdminClient,
  KeycloakAdminError,
  type KeycloakAdminConfig,
} from '../keycloak_admin.js';
import type { KeycloakUserRepresentation } from '../user_to_keycloak.js';

/**
 * The Admin-REST client. The behaviour that matters most is `createUser`
 * detecting that Keycloak assigned an id of its own (§6.3 spike 1) — a silent
 * substitution there would break `sub == user.id` for every migrated row.
 */

const CONFIG: KeycloakAdminConfig = {
  baseUrl: 'http://keycloak:8080/auth',
  realm: 'bluedots',
  clientId: 'signals-api',
  clientSecret: 'shh',
};

const USER_ID = '11111111-2222-3333-4444-555555555555';

const USER: KeycloakUserRepresentation = {
  id: USER_ID,
  username: 'asha@example.org',
  enabled: true,
  email: 'asha@example.org',
  emailVerified: true,
  attributes: {},
  realmRoles: ['signals_participant'],
  credentials: [],
  requiredActions: [],
};

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

let handler: Handler;
const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) =>
  handler(input instanceof URL ? input.toString() : String(input), init)
);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const TOKEN_URL = 'http://keycloak:8080/auth/realms/bluedots/protocol/openid-connect/token';
const USERS_URL = 'http://keycloak:8080/auth/admin/realms/bluedots/users';

const makeClient = () =>
  new KeycloakAdminClient(CONFIG, fetchMock as unknown as typeof fetch);

beforeEach(() => {
  fetchMock.mockClear();
  handler = () => json({ access_token: 'admin-token', expires_in: 300 });
});

describe('accessToken', () => {
  it('exchanges the client secret for a service-account token', async () => {
    const client = makeClient();

    expect(await client.accessToken()).toBe('admin-token');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(TOKEN_URL);
    const body = String((init as RequestInit).body);
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=signals-api');
    expect(body).toContain('client_secret=shh');
  });

  it('caches the token across calls', async () => {
    const client = makeClient();

    await client.accessToken(1_000);
    await client.accessToken(2_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches once the cached token nears expiry', async () => {
    const client = makeClient();

    await client.accessToken(0);
    // 300s lifetime minus the 30s safety margin.
    await client.accessToken(271_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('raises a helpful error when the client secret is wrong', async () => {
    handler = () => new Response('invalid_client', { status: 401 });
    const client = makeClient();

    await expect(client.accessToken()).rejects.toThrow(KeycloakAdminError);
    await expect(client.accessToken()).rejects.toThrow(/serviceAccountsEnabled/);
  });
});

describe('createUser', () => {
  it('reports `created` when Keycloak honours the supplied id', async () => {
    handler = (url, init) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      if (url === USERS_URL && init?.method === 'POST') {
        return new Response(null, {
          status: 201,
          headers: { location: `${USERS_URL}/${USER_ID}` },
        });
      }
      return new Response('unexpected', { status: 500 });
    };

    expect(await makeClient().createUser(USER)).toEqual({ kind: 'created' });
  });

  it('detects an id substitution from the Location header', async () => {
    // The case the whole non-destructive strategy hinges on. Keycloak has
    // historically ignored a client-supplied id and minted its own.
    const assigned = '99999999-8888-7777-6666-555555555555';
    handler = (url, init) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      if (url === USERS_URL && init?.method === 'POST') {
        return new Response(null, {
          status: 201,
          headers: { location: `${USERS_URL}/${assigned}` },
        });
      }
      return new Response('unexpected', { status: 500 });
    };

    expect(await makeClient().createUser(USER)).toEqual({
      kind: 'created_with_different_id',
      assignedId: assigned,
    });
  });

  it('falls back to a read-back when there is no Location header', async () => {
    handler = (url, init) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      if (url === USERS_URL && init?.method === 'POST') {
        return new Response(null, { status: 201 });
      }
      if (url === `${USERS_URL}/${USER_ID}`) return json({ id: USER_ID });
      return new Response('unexpected', { status: 500 });
    };

    expect(await makeClient().createUser(USER)).toEqual({ kind: 'created' });
  });

  it('treats a missing read-back as an id substitution, not a success', async () => {
    handler = (url, init) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      if (url === USERS_URL && init?.method === 'POST') {
        return new Response(null, { status: 201 });
      }
      if (url === `${USERS_URL}/${USER_ID}`) return new Response(null, { status: 404 });
      return new Response('unexpected', { status: 500 });
    };

    const result = await makeClient().createUser(USER);
    expect(result.kind).toBe('created_with_different_id');
  });

  it('reports `already_exists` on a 409 where the id is already present', async () => {
    // Idempotency: a re-run after a partial migration must be a no-op.
    handler = (url, init) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      if (url === USERS_URL && init?.method === 'POST') {
        return new Response('exists', { status: 409 });
      }
      if (url === `${USERS_URL}/${USER_ID}`) return json({ id: USER_ID });
      return new Response('unexpected', { status: 500 });
    };

    expect(await makeClient().createUser(USER)).toEqual({ kind: 'already_exists' });
  });

  it('reports `conflict` on a 409 where something else owns the username', async () => {
    // The §6.3 spike-2 collision: an aggregator user already holds this email.
    handler = (url, init) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      if (url === USERS_URL && init?.method === 'POST') {
        return new Response('User exists with same email', { status: 409 });
      }
      if (url === `${USERS_URL}/${USER_ID}`) return new Response(null, { status: 404 });
      return new Response('unexpected', { status: 500 });
    };

    const result = await makeClient().createUser(USER);
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.detail).toContain('same email');
  });

  it('throws on an unexpected failure rather than reporting success', async () => {
    handler = (url, init) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      if (url === USERS_URL && init?.method === 'POST') {
        return new Response('boom', { status: 500 });
      }
      return new Response('unexpected', { status: 500 });
    };

    await expect(makeClient().createUser(USER)).rejects.toThrow(KeycloakAdminError);
  });

  it('sends a bearer token on the admin call', async () => {
    handler = (url, init) => {
      if (url === TOKEN_URL) return json({ access_token: 'admin-token', expires_in: 300 });
      if (url === USERS_URL && init?.method === 'POST') {
        return new Response(null, {
          status: 201,
          headers: { location: `${USERS_URL}/${USER_ID}` },
        });
      }
      return new Response('unexpected', { status: 500 });
    };

    await makeClient().createUser(USER);

    // The token request is a POST too, so match on the users endpoint.
    const post = fetchMock.mock.calls.find(([url]) => String(url) === USERS_URL);
    const headers = (post?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer admin-token');
  });
});

describe('getUserById', () => {
  it('returns null for a 404 rather than throwing', async () => {
    handler = (url) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      return new Response(null, { status: 404 });
    };

    expect(await makeClient().getUserById(USER_ID)).toBeNull();
  });

  it('throws on a non-404 failure, so reconcile cannot silently under-report', async () => {
    handler = (url) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      return new Response('boom', { status: 500 });
    };

    await expect(makeClient().getUserById(USER_ID)).rejects.toThrow(KeycloakAdminError);
  });
});

describe('partialImportUsers', () => {
  it('imports with SKIP so a re-run is idempotent', async () => {
    let captured: unknown;
    handler = (url, init) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      captured = JSON.parse(String((init as RequestInit).body));
      return json({ added: 2, skipped: 1, overwritten: 0 });
    };

    const result = await makeClient().partialImportUsers([USER, { ...USER, id: 'other' }]);

    expect(result).toEqual({ added: 2, skipped: 1, overwritten: 0 });
    expect(captured).toMatchObject({ ifResourceExists: 'SKIP' });
  });

  it('defaults missing counters to zero', async () => {
    handler = (url) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      return json({});
    };

    expect(await makeClient().partialImportUsers([USER])).toEqual({
      added: 0,
      skipped: 0,
      overwritten: 0,
    });
  });
});

describe('attributesWillPersist', () => {
  /**
   * Guards against the silent-drop failure: Keycloak 26 ignores
   * `kc.user.profile.config` on realm import, and an undeclared attribute is
   * discarded on write rather than rejected. Verified on 26.5.5.
   */
  const withProfile = (profile: unknown): Handler => (url) => {
    if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
    return json(profile);
  };

  it('is true when the attribute is explicitly declared', async () => {
    handler = withProfile({ attributes: [{ name: 'phoneNumber' }] });
    expect(await makeClient().attributesWillPersist('phoneNumber')).toBe(true);
  });

  it('is true when unmanaged attributes are enabled', async () => {
    handler = withProfile({ unmanagedAttributePolicy: 'ENABLED', attributes: [] });
    expect(await makeClient().attributesWillPersist('phoneNumber')).toBe(true);
  });

  it.each(['ADMIN_EDIT', 'ADMIN_VIEW'])('accepts the %s policy', async (policy) => {
    handler = withProfile({ unmanagedAttributePolicy: policy, attributes: [] });
    expect(await makeClient().attributesWillPersist('phoneNumber')).toBe(true);
  });

  it('is false on a freshly-imported realm — the actual 26.5.5 shape', async () => {
    // Exactly what GET /users/profile returns after importing the realm JSON:
    // no policy, and only the four built-in attributes.
    handler = withProfile({
      attributes: [
        { name: 'username' },
        { name: 'email' },
        { name: 'firstName' },
        { name: 'lastName' },
      ],
    });
    expect(await makeClient().attributesWillPersist('phoneNumber')).toBe(false);
  });

  it('is false when the policy is explicitly disabled', async () => {
    handler = withProfile({ unmanagedAttributePolicy: 'DISABLED', attributes: [] });
    expect(await makeClient().attributesWillPersist('phoneNumber')).toBe(false);
  });

  it('throws rather than guessing when the profile cannot be read', async () => {
    handler = (url) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      return new Response('boom', { status: 500 });
    };
    await expect(makeClient().attributesWillPersist('phoneNumber')).rejects.toThrow(
      KeycloakAdminError
    );
  });
});

describe('deleteUser', () => {
  it('tolerates a 404 — cleanup should be idempotent', async () => {
    handler = (url) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      return new Response(null, { status: 404 });
    };

    await expect(makeClient().deleteUser(USER_ID)).resolves.toBeUndefined();
  });

  it('throws on a real failure', async () => {
    handler = (url) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      return new Response('boom', { status: 500 });
    };

    await expect(makeClient().deleteUser(USER_ID)).rejects.toThrow(KeycloakAdminError);
  });
});

describe('createUserPreservingId', () => {
  /**
   * The id-preserving create. Goes through partialImport because plain
   * POST /users mints its own id on KC 26.5.5 — verified empirically.
   */
  it('imports and confirms by reading the user back', async () => {
    let importCalled = false;
    let readCount = 0;
    handler = (url, init) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      if (url.endsWith('/partialImport') && init?.method === 'POST') {
        importCalled = true;
        return json({ added: 1, skipped: 0, overwritten: 0 });
      }
      if (url === `${USERS_URL}/${USER_ID}`) {
        // Absent before the import, present afterwards.
        readCount += 1;
        return importCalled ? json({ id: USER_ID }) : new Response(null, { status: 404 });
      }
      return new Response('unexpected', { status: 500 });
    };

    expect(await makeClient().createUserPreservingId(USER)).toEqual({ kind: 'created' });
    expect(importCalled).toBe(true);
    expect(readCount).toBe(2); // pre-check + verification
  });

  it('never touches POST /users', async () => {
    // The whole point: plain create would silently substitute the id.
    let imported = false;
    handler = (url, init) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      if (url === USERS_URL && init?.method === 'POST') {
        throw new Error('POST /users must not be used — it does not preserve the id');
      }
      if (url.endsWith('/partialImport')) { imported = true; return json({ added: 1 }); }
      if (url === `${USERS_URL}/${USER_ID}`) {
        return imported ? json({ id: USER_ID }) : new Response(null, { status: 404 });
      }
      return new Response('unexpected', { status: 500 });
    };

    await expect(makeClient().createUserPreservingId(USER)).resolves.toEqual({
      kind: 'created',
    });
  });

  it('short-circuits when the user already exists', async () => {
    let importCalled = false;
    handler = (url) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      if (url.endsWith('/partialImport')) { importCalled = true; return json({ added: 1 }); }
      if (url === `${USERS_URL}/${USER_ID}`) return json({ id: USER_ID });
      return new Response('unexpected', { status: 500 });
    };

    expect(await makeClient().createUserPreservingId(USER)).toEqual({
      kind: 'already_exists',
    });
    expect(importCalled).toBe(false);
  });

  it('reports a conflict when the import silently skipped the user', async () => {
    // partialImport(SKIP) returns 200 even when it wrote nothing, so trusting
    // the counters alone would report success for a user that was never created.
    handler = (url) => {
      if (url === TOKEN_URL) return json({ access_token: 't', expires_in: 300 });
      if (url.endsWith('/partialImport')) return json({ added: 0, skipped: 1 });
      if (url === `${USERS_URL}/${USER_ID}`) return new Response(null, { status: 404 });
      return new Response('unexpected', { status: 500 });
    };

    const result = await makeClient().createUserPreservingId(USER);
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.detail).toContain('already held by a different Keycloak user');
  });
});
