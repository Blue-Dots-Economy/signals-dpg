/**
 * Keycloak → local `user` mirror provisioning.
 *
 * This is the app-side home of the business logic that `unified_otp` married to
 * authentication (§4 of docs/superpowers/plans/2026-07-23-keycloak-migration-design.md).
 * Keycloak's OTP flow owns the *credential* half; everything below is the half
 * that has to keep happening when a human's token first reaches signals:
 *
 *   - the channel gate (LOGIN_CHANNELS)
 *   - the self-signup gate (SELF_SIGNUP_MODE) — see the R2 note below
 *   - the local `user` row (the mirror, keyed on the Keycloak `sub`)
 *   - the `member` / org-join row
 *   - guardian materialization for a U18 self-signup
 *
 * **The mirror is keyed on `sub`, and `sub` == `user.id` by design** (§6.1).
 * That equality is the whole reason domain data never moves: `items.created_by`
 * and every `*_owner` text column keep pointing at the same UUIDs. Nothing here
 * may ever mint a fresh id for a user that already exists.
 *
 * **R2 — the gated-signup gate must not reopen here.** Under
 * SELF_SIGNUP_MODE=gated, participants are created by an admin
 * (POST /api/v1/admin/participant), so a valid Keycloak token whose `sub` has
 * no local row means someone got an account another way. Provisioning refuses
 * to create the mirror for them. `unified_otp` enforced this at two call sites
 * as defence-in-depth; here there is exactly one place a user row can be born
 * from a login, and this is it.
 *
 * Nothing in this module throws for an expected failure — callers get a
 * discriminated result and map it to a status code, per the repo's
 * "routes never throw" convention.
 */

import { and, eq, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import {
  member as memberTable,
  organization as organizationTable,
  user as userTable,
} from '@api/db/postgres/schema/auth';
import { authConfig, keycloakConfig } from '@/config';
import { materializeSignupGuardian } from '@/services/signup_guardian';
import { takeSignupExtras } from '@/services/auth/signup_extras';
import type { KeycloakClaims } from '@/utils/keycloak_token';
import { KeycloakAdminClient } from '@/services/auth/keycloak_admin';
import { mapUserToKeycloak } from '@/services/auth/user_to_keycloak';
import { randomUUID } from 'node:crypto';

/** The shape the auth middleware puts on `request.user`. Unchanged contract. */
export interface ProvisionedUser {
  id: string;
  email: string;
  name: string;
  role?: string | null;
}

export type ProvisioningErrorCode =
  /** The identifier channel in the token is not enabled on this instance. */
  | 'LOGIN_CHANNEL_DISABLED'
  /** Gated instance, and this subject has no local row to log into (R2). */
  | 'SELF_SIGNUP_DISABLED'
  /** The local mirror says this user is banned (R8). */
  | 'USER_BANNED'
  /** A different local user already owns this token's email/phone. */
  | 'IDENTITY_CONFLICT'
  /** The token carries no usable identifier at all. */
  | 'NO_IDENTIFIER'
  /** Unexpected database failure. */
  | 'PROVISIONING_FAILED';

export type ProvisioningResult =
  | { ok: true; user: ProvisionedUser; created: boolean }
  | { ok: false; code: ProvisioningErrorCode; message: string };

/**
 * The claim carrying a signals organization id, if the realm maps one.
 * aggregator already emits `signalstack_org_id` from a user attribute, so the
 * same mapper serves signals in the shared realm.
 */
const ORG_ID_CLAIM = 'signalstack_org_id';

/** Postgres unique-violation. Provisioning races surface as this. */
const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

/** Keycloak sends email/phone as claims; normalise the way signals stores them. */
function normalizeEmail(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function normalizePhone(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The identity a token asserts, reduced to what the mirror stores. */
interface TokenIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
  name: string;
  orgId: string | null;
}

function readIdentity(claims: KeycloakClaims): TokenIdentity {
  const email = normalizeEmail(claims.email);
  const phoneNumber = normalizePhone(claims.phone_number);

  // Keycloak splits the name; signals stores one column. `name` is populated
  // when a full-name mapper is configured, so prefer it and fall back to the
  // parts. 'user' matches what unified_otp defaulted to on create.
  const joined = [claims.given_name, claims.family_name]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ')
    .trim();
  const name = claims.name?.trim() || joined || 'user';

  const rawOrgId = claims[ORG_ID_CLAIM];

  return {
    sub: claims.sub,
    email,
    emailVerified: claims.email_verified === true,
    phoneNumber,
    // Keycloak stores this as a user attribute, so it can arrive as a string.
    phoneNumberVerified:
      claims.phone_number_verified === true || claims.phone_number_verified === 'true',
    name,
    orgId: typeof rawOrgId === 'string' && rawOrgId.trim() !== '' ? rawOrgId.trim() : null,
  };
}

/**
 * Channel gate, relocated from `assertChannelAllowed`.
 *
 * Semantics differ slightly from the OTP version by necessity: there, the
 * caller named the channel it wanted to use, so a disabled channel could be
 * rejected outright. A token just carries whichever identifiers Keycloak knows
 * about, so the rule is "at least one identifier on an enabled channel" — a
 * user with both an email and a phone on an email-only instance is fine.
 *
 * This is what keeps open question 9(b) from biting silently: on an instance
 * with no SMS provider and LOGIN_CHANNELS=email, a phone-only user is refused
 * here with a clear code rather than half-provisioned.
 */
function channelAllowed(identity: TokenIdentity): boolean {
  const channels = authConfig.login_channels;
  if (identity.email && channels.includes('email')) return true;
  if (identity.phoneNumber && channels.includes('phone')) return true;
  return false;
}

/**
 * Resolve a Keycloak token's subject to a local `user` row, creating the mirror
 * on first login. Returns the row shaped for `request.user`.
 *
 * Callers pass a logger so the side-effecting steps (org join, guardian
 * materialization) can report failures without being able to fail the login.
 */
export async function provisionUserFromClaims(
  claims: KeycloakClaims,
  log: FastifyBaseLogger
): Promise<ProvisioningResult> {
  const identity = readIdentity(claims);

  if (!identity.email && !identity.phoneNumber) {
    return {
      ok: false,
      code: 'NO_IDENTIFIER',
      message: 'Token carries neither an email nor a phone number',
    };
  }

  if (!channelAllowed(identity)) {
    return {
      ok: false,
      code: 'LOGIN_CHANNEL_DISABLED',
      message:
        'None of this account’s login identifiers use a channel enabled on this instance.',
    };
  }

  let existing;
  try {
    [existing] = await db
      .select()
      .from(userTable)
      .where(eq(userTable.id, identity.sub))
      .limit(1);
  } catch (err) {
    log.error({ err, sub: identity.sub }, 'provisioning: failed to read user mirror');
    return {
      ok: false,
      code: 'PROVISIONING_FAILED',
      message: 'Could not resolve the local user record',
    };
  }

  if (existing) {
    if (existing.banned) {
      return {
        ok: false,
        code: 'USER_BANNED',
        message: existing.banReason?.trim() || 'This account has been suspended.',
      };
    }

    const refreshed = await refreshMirror(existing, identity, log);
    if (!refreshed.ok) return refreshed;

    // Membership can be granted after the account exists, so this is checked
    // on every login, not just the first.
    await ensureOrgMembership(refreshed.user.id, identity, log);
    return refreshed;
  }

  return createMirror(identity, log);
}

/**
 * Bring an existing mirror row in line with the token.
 *
 * Keycloak is authoritative for email / phone / verified flags / name (§6.1),
 * so a change there propagates down. Signals-local columns (`domains`,
 * `date_of_birth`, onboarding attribution, `tags`) are never touched here —
 * that is the whole point of the ownership split.
 *
 * `role` is deliberately NOT synced from realm roles yet: today's `user.role`
 * still comes from the better-auth admin plugin, and overwriting it from a
 * token before the realm roles are actually assigned would silently demote
 * every existing admin.
 */
async function refreshMirror(
  existing: typeof userTable.$inferSelect,
  identity: TokenIdentity,
  log: FastifyBaseLogger
): Promise<ProvisioningResult> {
  const updates: Partial<typeof userTable.$inferInsert> = {};

  if (identity.email && identity.email !== existing.email) {
    updates.email = identity.email;
  }
  if (identity.emailVerified && !existing.emailVerified) {
    updates.emailVerified = true;
  }
  if (identity.phoneNumber && identity.phoneNumber !== existing.phoneNumber) {
    updates.phoneNumber = identity.phoneNumber;
  }
  if (identity.phoneNumberVerified && !existing.phoneNumberVerified) {
    updates.phoneNumberVerified = true;
  }
  // Only fill a placeholder name — a name edited locally shouldn't be stomped
  // by Keycloak's 'user' default on every request.
  if (identity.name !== 'user' && (!existing.name || existing.name === 'user')) {
    updates.name = identity.name;
  }

  const user: ProvisionedUser = {
    id: existing.id,
    email: updates.email ?? existing.email ?? '',
    name: updates.name ?? existing.name,
    role: existing.role,
  };

  if (Object.keys(updates).length === 0) {
    return { ok: true, user, created: false };
  }

  try {
    updates.updatedAt = new Date();
    await db.update(userTable).set(updates).where(eq(userTable.id, existing.id));
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      // Keycloak moved this subject onto an email/phone another local user
      // already holds. Refusing is the only safe move — merging two users
      // would repoint domain data, which this design exists to avoid (§2.3).
      log.error(
        { err, sub: identity.sub },
        'provisioning: token identifiers collide with another local user',
      );
      return {
        ok: false,
        code: 'IDENTITY_CONFLICT',
        message:
          'This account’s email or phone number is already registered to a different user.',
      };
    }
    log.error({ err, sub: identity.sub }, 'provisioning: failed to refresh user mirror');
    return {
      ok: false,
      code: 'PROVISIONING_FAILED',
      message: 'Could not update the local user record',
    };
  }

  return { ok: true, user, created: false };
}

/**
 * First login for this subject: create the local mirror.
 *
 * Two gates run before anything is written — the self-signup gate (R2) and a
 * check that no *other* local row already owns these identifiers.
 */
async function createMirror(
  identity: TokenIdentity,
  log: FastifyBaseLogger
): Promise<ProvisioningResult> {
  // R2. A gated instance creates participants through the admin path, which
  // writes the local row itself; reaching here with no row means this subject
  // was not onboarded by signals.
  if (!authConfig.allow_self_signup) {
    log.warn(
      { sub: identity.sub },
      'provisioning: refused to create a user mirror — self-signup is gated',
    );
    return {
      ok: false,
      code: 'SELF_SIGNUP_DISABLED',
      message:
        'Self sign-up is disabled on this instance. Please contact your administrator to get onboarded.',
    };
  }

  // A local row holding these identifiers under a *different* id means the
  // Keycloak subject and the signals user have diverged — the §6.3 spike-2
  // collision case. Never create a second row; never rewrite the first one's
  // id (domain data points at it).
  const identifierFilters = [
    identity.email ? eq(userTable.email, identity.email) : undefined,
    identity.phoneNumber ? eq(userTable.phoneNumber, identity.phoneNumber) : undefined,
  ].filter((f): f is NonNullable<typeof f> => f !== undefined);

  try {
    const [clash] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(identifierFilters.length === 1 ? identifierFilters[0] : or(...identifierFilters))
      .limit(1);

    if (clash) {
      log.error(
        { sub: identity.sub, existing_user_id: clash.id },
        'provisioning: token subject does not match the local user holding its identifiers',
      );
      return {
        ok: false,
        code: 'IDENTITY_CONFLICT',
        message:
          'This email or phone number is already registered under a different account.',
      };
    }
  } catch (err) {
    log.error({ err, sub: identity.sub }, 'provisioning: identifier pre-check failed');
    return {
      ok: false,
      code: 'PROVISIONING_FAILED',
      message: 'Could not verify the local user record',
    };
  }

  const now = new Date();
  try {
    await db.insert(userTable).values({
      // The linchpin: the mirror's primary key IS the Keycloak subject.
      id: identity.sub,
      name: identity.name,
      email: identity.email,
      emailVerified: identity.emailVerified,
      phoneNumber: identity.phoneNumber,
      phoneNumberVerified: identity.phoneNumberVerified,
      image: '',
      role: 'user',
      banned: false,
      banReason: '',
      banExpires: null,
      // Parity with unified_otp's create: reaching a completed login means the
      // consent screens were passed. DOB stays null here — it is captured
      // post-login, or written by guardian materialization below.
      termsAccepted: true,
      privacyAccepted: true,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      // Two concurrent first-login requests. The other one won; re-read.
      log.warn({ sub: identity.sub }, 'provisioning: concurrent first login, re-reading');
      const [row] = await db
        .select()
        .from(userTable)
        .where(eq(userTable.id, identity.sub))
        .limit(1);
      if (row) {
        await ensureOrgMembership(row.id, identity, log);
        return {
          ok: true,
          user: { id: row.id, email: row.email ?? '', name: row.name, role: row.role },
          created: false,
        };
      }
      return {
        ok: false,
        code: 'IDENTITY_CONFLICT',
        message:
          'This email or phone number is already registered under a different account.',
      };
    }
    log.error({ err, sub: identity.sub }, 'provisioning: failed to create user mirror');
    return {
      ok: false,
      code: 'PROVISIONING_FAILED',
      message: 'Could not create the local user record',
    };
  }

  const user: ProvisionedUser = {
    id: identity.sub,
    email: identity.email ?? '',
    name: identity.name,
    role: 'user',
  };

  // Apply anything the self-signup form parked for this identifier (§ the
  // Keycloak signup path creates the identity before the local row exists, so
  // `domains` and DOB have nowhere to go until now — see signup_extras.ts).
  //
  // Runs BEFORE guardian materialization on purpose: for a gated minor the
  // guardian capture is the OTP-verified record and must win on DOB.
  await applySignupExtras(user.id, identity, log);

  await ensureOrgMembership(user.id, identity, log);

  // Guardian materialization, relocated from the better-auth `afterUserCreate`
  // hook (create_auth.ts:38-44). Same contract as there: genuinely-new users
  // only, and a failure is logged but never blocks the login — a half-captured
  // guardian record must not lock a ward out of their own account.
  try {
    await materializeSignupGuardian({
      id: user.id,
      email: identity.email,
      phoneNumber: identity.phoneNumber,
    });
  } catch (err) {
    log.error({ err, user_id: user.id }, 'materializeSignupGuardian failed');
  }

  return { ok: true, user, created: true };
}

/**
 * Write the `member` row for a token that names an organization, relocated
 * from `verifyOtp`'s `joinOrg` branch.
 *
 * Best-effort by design, exactly as it was there: an org that doesn't exist or
 * a failed insert is logged and skipped, never surfaced as a login failure.
 * Where `unified_otp` took an org *slug* from the request body, the token
 * carries an org *id* claim — there is no request body at token-validation
 * time.
 */
async function ensureOrgMembership(
  userId: string,
  identity: TokenIdentity,
  log: FastifyBaseLogger
): Promise<void> {
  if (!identity.orgId) return;

  try {
    const [org] = await db
      .select({ id: organizationTable.id })
      .from(organizationTable)
      .where(eq(organizationTable.id, identity.orgId))
      .limit(1);

    if (!org) {
      log.warn(
        { user_id: userId, org_id: identity.orgId },
        'provisioning: token names an organization that does not exist locally',
      );
      return;
    }

    // Scoped to (org, user) exactly as unified_otp did — a user may belong to
    // more than one org, so checking by user alone would skip the second join.
    const [already] = await db
      .select({ id: memberTable.id })
      .from(memberTable)
      .where(and(eq(memberTable.organizationId, org.id), eq(memberTable.userId, userId)))
      .limit(1);

    if (already) return;

    await db.insert(memberTable).values({
      id: randomUUID(),
      organizationId: org.id,
      userId,
      role: 'member',
      teamId: null,
      createdAt: new Date(),
    });
  } catch (err) {
    log.error(
      { err, user_id: userId, org_id: identity.orgId },
      'provisioning: failed to create org membership',
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// JIT safety net (§6.2)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Backfill a Keycloak identity shell for a local user who does not have one,
 * preserving their existing UUID.
 *
 * **Why this is triggered from the better-auth path, not a Keycloak token.**
 * The straggler case §6.2 describes is a user who exists locally but was not
 * in Keycloak at bulk-load time — e.g. admin-onboarded between the R4 run and
 * cutover. Such a user cannot present a Keycloak token at all: Keycloak has no
 * account for them, and realm registration is disabled, so its own OTP flow
 * rejects them before signals ever sees a request. The only moment signals both
 * knows who they are *and* can still fix it is when they log in the old way,
 * during the `dual` window. So that is where this hooks in.
 *
 * (The other direction — a Keycloak subject whose identifiers belong to a
 * different local user — is the §6.3 spike-2 collision, and is deliberately
 * refused as IDENTITY_CONFLICT rather than resolved here. Rekeying domain data
 * is exactly what this design exists to avoid.)
 *
 * Best-effort and non-blocking by construction:
 *   - never throws, so a caller can `void` it;
 *   - writes only to Keycloak, so it is reversible (the R4 gate);
 *   - deduped per process, so a returning user costs one Keycloak call once,
 *     not one per login.
 *
 * The bulk script remains the primary path — users who never log in still need
 * shells so admin queries stay complete, and this only ever sees people who do.
 */
const shellBackfillAttempted = new Set<string>();
let adminClient: KeycloakAdminClient | null = null;
let adminClientUnavailableLogged = false;
/**
 * Whether this realm actually retains the `phoneNumber` attribute. Checked once
 * per process, because Keycloak 26 ignores `kc.user.profile.config` on realm
 * import and then DISCARDS writes to undeclared attributes without erroring —
 * so a backfilled user would silently end up unable to receive a phone OTP.
 * null = not yet checked.
 */
let attributesPersist: boolean | null = null;

/** Test seam: forget the dedupe set, memoised admin client and probe result. */
export function resetKeycloakShellBackfillState(): void {
  shellBackfillAttempted.clear();
  adminClient = null;
  adminClientUnavailableLogged = false;
  attributesPersist = null;
}

function getAdminClient(log: FastifyBaseLogger): KeycloakAdminClient | null {
  if (adminClient) return adminClient;

  if (!keycloakConfig.internal_base_url || !keycloakConfig.api_client_secret) {
    if (!adminClientUnavailableLogged) {
      adminClientUnavailableLogged = true;
      log.warn(
        'keycloak shell backfill is disabled: KEYCLOAK_API_CLIENT_SECRET (or ' +
          'base URL) is not configured. Stragglers will need the bulk migration ' +
          'script re-run instead.',
      );
    }
    return null;
  }

  adminClient = new KeycloakAdminClient({
    baseUrl: keycloakConfig.internal_base_url,
    realm: keycloakConfig.realm,
    clientId: keycloakConfig.api_client_id,
    clientSecret: keycloakConfig.api_client_secret,
  });
  return adminClient;
}

export async function backfillKeycloakShell(
  userId: string,
  log: FastifyBaseLogger
): Promise<void> {
  // Only meaningful mid-migration. Under `betterauth` there is nothing to
  // backfill into; under `keycloak` the old path no longer runs.
  if (authConfig.provider !== 'dual') return;
  if (shellBackfillAttempted.has(userId)) return;
  shellBackfillAttempted.add(userId);

  try {
    const client = getAdminClient(log);
    if (!client) return;

    // Refuse to write a user whose phone attribute would be thrown away.
    if (attributesPersist === null) {
      attributesPersist = await client.attributesWillPersist('phoneNumber');
      if (!attributesPersist) {
        log.error(
          'keycloak shell backfill disabled: this realm discards the ' +
            '`phoneNumber` attribute, so backfilled users could not receive a ' +
            'phone OTP. Run infra/keycloak/init/apply-user-profile.sh against ' +
            'the realm, then restart.',
        );
      }
    }
    if (!attributesPersist) return;

    if (await client.getUserById(userId)) return;

    const [row] = await db
      .select({
        id: userTable.id,
        name: userTable.name,
        email: userTable.email,
        emailVerified: userTable.emailVerified,
        phoneNumber: userTable.phoneNumber,
        phoneNumberVerified: userTable.phoneNumberVerified,
        role: userTable.role,
        banned: userTable.banned,
        banReason: userTable.banReason,
        banExpires: userTable.banExpires,
      })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);

    if (!row) return;

    const mapped = mapUserToKeycloak(row);
    if (!mapped.ok) {
      log.warn(
        { user_id: userId, reason: mapped.message },
        'keycloak shell backfill skipped: user row is not mappable',
      );
      return;
    }

    // partialImport, NOT POST /users: on KC 26.5.5 plain create ignores the
    // supplied id, which would break the sub == user.id invariant this whole
    // migration depends on.
    const outcome = await client.createUserPreservingId(mapped.user);

    switch (outcome.kind) {
      case 'created':
        log.info({ user_id: userId }, 'backfilled a Keycloak shell for a straggler');
        return;
      case 'already_exists':
        return;
      case 'conflict':
        log.error(
          { user_id: userId, detail: outcome.detail },
          'keycloak shell backfill conflicted: another Keycloak user already holds ' +
            'these identifiers (see §6.3 spike 2)',
        );
        return;
      case 'created_with_different_id':
        // The UUID-preservation invariant just broke. Remove the wrongly-keyed
        // user immediately rather than leaving an identity whose sub does not
        // match any local row.
        log.error(
          { user_id: userId, assigned_id: outcome.assignedId },
          'keycloak shell backfill did NOT preserve the UUID — removing the ' +
            'created user. This Keycloak ignores a supplied id; the migration ' +
            'needs --strategy=import (§6.3 spike 1).',
        );
        await client.deleteUser(outcome.assignedId).catch(() => {});
        return;
    }
  } catch (err) {
    // Deliberately swallowed: this runs alongside a login that has already
    // succeeded, and a Keycloak outage must not turn it into a failure.
    log.error({ err, user_id: userId }, 'keycloak shell backfill failed');
  }
}

/**
 * Move the parked signup fields onto the freshly-created mirror row.
 *
 * Best-effort: these are recoverable through the normal UI (`setUserDomains`,
 * the DOB step), so a Redis outage must not fail a login that has already
 * succeeded. A user with no stash — migrated, or admin-onboarded — is the
 * common case and costs one Redis read.
 */
async function applySignupExtras(
  userId: string,
  identity: TokenIdentity,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    const extras = await takeSignupExtras({
      email: identity.email,
      phoneNumber: identity.phoneNumber,
    });
    if (!extras) return;

    const updates: Partial<typeof userTable.$inferInsert> = {};
    if (extras.domain) updates.domains = [extras.domain];
    if (typeof extras.age === 'number') updates.age = extras.age;
    if (Object.keys(updates).length === 0) return;

    updates.updatedAt = new Date();
    await db.update(userTable).set(updates).where(eq(userTable.id, userId));
    log.info(
      { user_id: userId, domain: extras.domain ?? null, age: extras.age ?? null },
      'provisioning: applied parked signup details',
    );
  } catch (err) {
    log.error({ err, user_id: userId }, 'provisioning: could not apply parked signup details');
  }
}
