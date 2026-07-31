/**
 * Keycloak Admin REST client, authenticated as the `signals-api` service
 * account (which holds the realm-management roles the realm export grants it).
 *
 * Used by the user migration (Build 4) and, later, by admin participant
 * creation in place of better-auth's `signUpEmail` (Build 5).
 *
 * Config is passed in rather than imported from `@/config` on purpose: the
 * migration runs as a standalone script, and importing the app config would
 * drag in `loadEnv()` and require every unrelated app env var to be present —
 * the same reason `scripts/seed_service_users.ts` builds its own db handle.
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
  /** Created with the id we asked for — the happy path. */
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
   * Obtain (and cache) a service-account access token.
   *
   * Cached with a 30s safety margin so a long migration run does not fetch one
   * per request, nor use a token that expires mid-flight.
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

  private async request(
    path: string,
    init: RequestInit & { method: string }
  ): Promise<Response> {
    const token = await this.accessToken();
    return this.fetchImpl(`${this.adminBase}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
        authorization: `Bearer ${token}`,
      },
    });
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

  /** Exact-match search. Used to detect the §6.3 spike-2 collision case. */
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
   * Exists so callers can *verify* rather than assume: `partialImport` carries
   * `realmRoles` in the user representation, but whether Keycloak honours them
   * is a property of the import, not something the response body confirms. The
   * admin-bootstrap script (`scripts/create_admin_user.ts`) checks this after
   * writing, because a silently-unassigned `signals_admin` would make a real
   * admin invisible to any realm-role → `user.role` sync.
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
   * Create one user via `POST /users`, then verify the id actually stuck.
   *
   * The verification is the point (§6.3 spike 1): Keycloak has historically
   * ignored a client-supplied `id` on create and assigned its own. A silent
   * substitution here would break the `sub == user.id` invariant for every
   * migrated row, so this reads the created user back out of the Location
   * header rather than assuming success means what we asked for.
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
   * Goes through `partialImport` rather than `POST /users`, because on Keycloak
   * 26.5.5 plain create **ignores a client-supplied `id`** and mints its own
   * (verified — see `migrate_users_to_keycloak.ts --probe`). `sub` must equal
   * the local `user.id` or every `created_by` / `*_owner` column stops matching
   * its owner, so the only usable path is the one that honours the id.
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
   * Create users via `partialImport`, the documented fallback when plain create
   * will not honour a supplied `id` (§6.3 spike 1, and Build 4's stated
   * dependency). Same field mapping — only the transport differs.
   *
   * `SKIP` on an existing id keeps the run idempotent.
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
   * Needed because Keycloak 26 ignores `kc.user.profile.config` on realm
   * import, and an undeclared attribute is **silently dropped** on write rather
   * than rejected — see `attributesWillPersist`.
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
   * attributes are enabled. If neither holds, Keycloak accepts the write and
   * throws the value away — so a migration would report success while leaving
   * every phone-only user unable to receive an OTP.
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
