/**
 * Keycloak Admin REST client, authenticated as the `signals-api` service
 * account (which holds realm-management roles). Used by self-signup, admin
 * participant creation, and the migration / admin-bootstrap scripts.
 *
 * Config is passed in rather than imported from `@/config` because the scripts
 * run standalone, and the app config would require every app env var.
 */

import type { KeycloakUserRepresentation } from './user_to_keycloak';

export interface KeycloakAdminConfig {
  /** Base URL this process dials, including any relative path (e.g. /auth). */
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
}

export class KeycloakAdminError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string
  ) {
    super(message);
    this.name = 'KeycloakAdminError';
  }
}

/** What the Admin API returns when reading a user back. */
export interface KeycloakUserSummary {
  id: string;
  username?: string;
  enabled?: boolean;
  email?: string;
  emailVerified?: boolean;
  attributes?: Record<string, string[]>;
}

/** Result of trying to create one user. */
export type CreateOutcome =
  /** Created with the id we asked for. */
  | { kind: 'created' }
  /**
   * Created, but Keycloak assigned its own id. Fatal for this strategy: the
   * `sub` would no longer equal `user.id`.
   */
  | { kind: 'created_with_different_id'; assignedId: string }
  /** A user with this id already exists — the migration is idempotent. */
  | { kind: 'already_exists' }
  /** Something else already owns this username/email/phone. */
  | { kind: 'conflict'; detail: string };

export class KeycloakAdminClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly config: KeycloakAdminConfig,
    /** Injectable for tests; defaults to global fetch. */
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private get realmBase(): string {
    return `${this.config.baseUrl.replace(/\/$/, '')}/realms/${this.config.realm}`;
  }

  private get adminBase(): string {
    return `${this.config.baseUrl.replace(/\/$/, '')}/admin/realms/${this.config.realm}`;
  }

  /**
   * Obtain a service-account access token, cached until 30s before expiry so a
   * token is not used as it expires mid-flight.
   */
  async accessToken(now: number = Date.now()): Promise<string> {
    if (this.token && now < this.tokenExpiresAt) return this.token;

    const res = await this.fetchImpl(`${this.realmBase}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }).toString(),
    });

    if (!res.ok) {
      throw new KeycloakAdminError(
        `Could not obtain a Keycloak service-account token (is ${this.config.clientId} ` +
          'configured with serviceAccountsEnabled and the right secret?)',
        res.status,
        await safeText(res)
      );
    }

    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new KeycloakAdminError('Keycloak token response carried no access_token');
    }

    this.token = body.access_token;
    this.tokenExpiresAt = now + Math.max((body.expires_in ?? 60) - 30, 10) * 1000;
    return this.token;
  }

  /** Drop the cached token so the next call fetches a fresh one. */
  private forgetToken(): void {
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  /**
   * One Admin-REST call, retried once on 401 with a fresh token. The cached
   * token can go stale before `expires_in` (session revoked, secret rotated,
   * Keycloak restarted with a new key). One retry only, so a genuinely
   * unauthorised client still fails fast.
   *
   * Bodies are always strings, never streams, so the request is safe to replay.
   */
  private async request(
    path: string,
    init: RequestInit & { method: string }
  ): Promise<Response> {
    const send = async (): Promise<Response> => {
      const token = await this.accessToken();
      return this.fetchImpl(`${this.adminBase}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
          authorization: `Bearer ${token}`,
        },
      });
    };

    const res = await send();
    if (res.status !== 401) return res;

    this.forgetToken();
    return send();
  }

  /** Fetch a user by id. null when absent. */
  async getUserById(id: string): Promise<KeycloakUserSummary | null> {
    const res = await this.request(`/users/${encodeURIComponent(id)}`, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new KeycloakAdminError(
        `Failed to read Keycloak user ${id}`,
        res.status,
        await safeText(res)
      );
    }
    return (await res.json()) as KeycloakUserSummary;
  }

  /** Exact-match search by email; used to detect identifier collisions. */
  async findByEmail(email: string): Promise<Array<{ id: string; username?: string }>> {
    const query = new URLSearchParams({ email, exact: 'true', max: '5' });
    const res = await this.request(`/users?${query.toString()}`, { method: 'GET' });
    if (!res.ok) {
      throw new KeycloakAdminError(
        `Failed to search Keycloak users by email`,
        res.status,
        await safeText(res)
      );
    }
    return (await res.json()) as Array<{ id: string; username?: string }>;
  }

  /**
   * The realm roles actually assigned to a user.
   *
   * `partialImport` carries `realmRoles`, but its response does not confirm
   * they were assigned, so `scripts/create_admin_user.ts` verifies with this
   * after writing.
   */
  async realmRolesFor(id: string): Promise<string[]> {
    const res = await this.request(
      `/users/${encodeURIComponent(id)}/role-mappings/realm`,
      { method: 'GET' }
    );
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new KeycloakAdminError(
        `Failed to read realm roles for Keycloak user ${id}`,
        res.status,
        await safeText(res)
      );
    }
    const roles = (await res.json()) as Array<{ name?: string }>;
    return roles
      .map((r) => r.name)
      .filter((n): n is string => typeof n === 'string' && n !== '');
  }

  /** Search by the `phoneNumber` user attribute. */
  async findByPhone(phone: string): Promise<Array<{ id: string; username?: string }>> {
    const query = new URLSearchParams({ q: `phoneNumber:${phone}`, max: '5' });
    const res = await this.request(`/users?${query.toString()}`, { method: 'GET' });
    if (!res.ok) {
      throw new KeycloakAdminError(
        `Failed to search Keycloak users by phone`,
        res.status,
        await safeText(res)
      );
    }
    return (await res.json()) as Array<{ id: string; username?: string }>;
  }

  /**
   * Create one user via `POST /users`, then verify the id stuck. Keycloak may
   * ignore a client-supplied `id` and assign its own, which would break
   * `sub == user.id`, so the Location header (or a read-back) is checked.
   */
  async createUser(user: KeycloakUserRepresentation): Promise<CreateOutcome> {
    const res = await this.request('/users', {
      method: 'POST',
      body: JSON.stringify(user),
    });

    if (res.status === 409) {
      const detail = await safeText(res);
      // 409 on a create we intended to be idempotent: distinguish "same id
      // already migrated" from "someone else owns this username".
      const existing = await this.getUserById(user.id).catch(() => null);
      if (existing) return { kind: 'already_exists' };
      return { kind: 'conflict', detail };
    }

    if (!res.ok) {
      throw new KeycloakAdminError(
        `Failed to create Keycloak user ${user.id}`,
        res.status,
        await safeText(res)
      );
    }

    // Keycloak returns the new resource in Location: .../users/<id>.
    const assignedId = res.headers.get('location')?.split('/').pop();
    if (assignedId && assignedId !== user.id) {
      return { kind: 'created_with_different_id', assignedId };
    }

    // No Location header to check — confirm by id instead.
    if (!assignedId) {
      const created = await this.getUserById(user.id);
      if (!created) {
        return { kind: 'created_with_different_id', assignedId: '(unknown)' };
      }
    }

    return { kind: 'created' };
  }

  /**
   * Create one user with its id preserved.
   *
   * Uses `partialImport` rather than `POST /users`, because Keycloak 26.5.5
   * plain create ignores a client-supplied `id` (see
   * `migrate_users_to_keycloak.ts --probe`), and `sub` must equal the local
   * `user.id` that `created_by` / `*_owner` columns point at.
   *
   * Verifies by reading the user back rather than trusting the import counters:
   * a `skipped` result can mean either "already there" or "something else owns
   * these identifiers", and those need different answers.
   */
  async createUserPreservingId(
    user: KeycloakUserRepresentation
  ): Promise<CreateOutcome> {
    if (await this.getUserById(user.id)) return { kind: 'already_exists' };

    const result = await this.partialImportUsers([user]);

    if (await this.getUserById(user.id)) return { kind: 'created' };

    return {
      kind: 'conflict',
      detail:
        `partialImport reported added=${result.added} skipped=${result.skipped} ` +
        `but no user exists with id ${user.id} — its email or phone is most ` +
        'likely already held by a different Keycloak user',
    };
  }

  /**
   * Create users via `partialImport`, which honours a supplied `id`.
   * `SKIP` on an existing resource keeps re-runs idempotent.
   */
  async partialImportUsers(
    users: KeycloakUserRepresentation[]
  ): Promise<{ added: number; skipped: number; overwritten: number }> {
    const res = await this.request('/partialImport', {
      method: 'POST',
      body: JSON.stringify({ ifResourceExists: 'SKIP', users }),
    });

    if (!res.ok) {
      throw new KeycloakAdminError(
        'partialImport failed',
        res.status,
        await safeText(res)
      );
    }

    const body = (await res.json()) as {
      added?: number;
      skipped?: number;
      overwritten?: number;
    };
    return {
      added: body.added ?? 0,
      skipped: body.skipped ?? 0,
      overwritten: body.overwritten ?? 0,
    };
  }

  /**
   * The realm's user-profile config.
   *
   * Keycloak 26 ignores `kc.user.profile.config` on realm import, and silently
   * drops an undeclared attribute on write; see `attributesWillPersist`.
   */
  async getUserProfile(): Promise<{
    unmanagedAttributePolicy?: string;
    attributes?: Array<{ name: string }>;
  }> {
    const res = await this.request('/users/profile', { method: 'GET' });
    if (!res.ok) {
      throw new KeycloakAdminError(
        'Failed to read the realm user profile',
        res.status,
        await safeText(res)
      );
    }
    return (await res.json()) as {
      unmanagedAttributePolicy?: string;
      attributes?: Array<{ name: string }>;
    };
  }

  /**
   * Will a write of `attribute` actually be retained by this realm?
   *
   * True when the attribute is declared in the user profile, or when unmanaged
   * attributes are enabled. Otherwise Keycloak accepts the write and discards
   * the value, leaving phone-only users unable to receive an OTP.
   */
  async attributesWillPersist(attribute: string): Promise<boolean> {
    const profile = await this.getUserProfile();
    const declared = (profile.attributes ?? []).some((a) => a.name === attribute);
    const policy = profile.unmanagedAttributePolicy;
    const unmanagedEnabled =
      policy === 'ENABLED' || policy === 'ADMIN_EDIT' || policy === 'ADMIN_VIEW';
    return declared || unmanagedEnabled;
  }

  async deleteUser(id: string): Promise<void> {
    const res = await this.request(`/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      throw new KeycloakAdminError(
        `Failed to delete Keycloak user ${id}`,
        res.status,
        await safeText(res)
      );
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
