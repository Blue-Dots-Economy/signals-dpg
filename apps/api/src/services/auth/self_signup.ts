/**
 * Self-signup under Keycloak.
 *
 * The custom OTP authenticator is **login-only** — `IdentifierFormAuthenticator`
 * looks a user up and fails with `user_not_found` if absent, and nothing in the
 * SPI can create one. Keycloak's own registration form is no substitute: it is
 * password-based (breaking the passwordless model) and captures none of signals'
 * onboarding data. So signals creates the identity itself and then hands the
 * browser to Keycloak to actually authenticate it.
 *
 * The division of labour:
 *
 *   1. here — mint the UUID, create the Keycloak identity (unverified)
 *   2. Keycloak — prove the person owns the identifier, via the OTP flow
 *   3. `provisionUserFromClaims` — create the local `user` mirror on first
 *      successful login, which is also where guardian materialization and the
 *      org-join already happen
 *
 * **No local `user` row is written here**, deliberately. Until someone completes
 * an OTP login there is no proof they own the identifier, so an abandoned or
 * malicious signup leaves an unverified Keycloak shell and nothing else — no
 * signals user, no domain data, nothing joined to an org.
 *
 * `domains`, date-of-birth and consent are NOT collected here either: the UI
 * already submits those after login (`setUserDomains`, `submitU18Dob`), and the
 * U18 guardian capture has its own pre-auth flow keyed on the identifier.
 */

import { randomUUID } from 'node:crypto';
import { or, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { user as userTable } from '@api/db/postgres/schema/auth';
import { redis } from '@api/db/secondary/redis';
import { apiConfig, authConfig, keycloakConfig } from '@/config';
import { stashSignupExtras } from '@/services/auth/signup_extras';
import { KeycloakAdminClient } from '@/services/auth/keycloak_admin';
import { mapUserToKeycloak } from '@/services/auth/user_to_keycloak';

export interface SelfSignupInput {
  name: string;
  email?: string | null;
  phoneNumber?: string | null;
  /** Network domain to join. Validated against this instance's served domains. */
  domain?: string | null;
  /** ISO date string. Parked for provisioning to apply at first login. */
  dateOfBirth?: string | null;
  /** Caller IP, for rate limiting. */
  clientIp?: string;
}

export type SelfSignupErrorCode =
  /** This instance isn't running Keycloak, so there is nothing to create in. */
  | 'SIGNUP_NOT_AVAILABLE'
  /** SELF_SIGNUP_MODE=gated — participants are admin-onboarded. */
  | 'SELF_SIGNUP_DISABLED'
  | 'NO_IDENTIFIER'
  | 'LOGIN_CHANNEL_DISABLED'
  | 'SIGNUP_RATE_LIMITED'
  /** Domain isn't one this instance serves. */
  | 'DOMAIN_NOT_SERVED'
  | 'INVALID_DATE_OF_BIRTH'
  | 'SIGNUP_FAILED';

export type SelfSignupResult =
  | {
      ok: true;
      /**
       * True when the identifier already belongs to someone. Reported as success
       * so the UI can send them to sign in — the public `check-user` endpoint
       * already exposed existence, so this leaks nothing new.
       */
      alreadyRegistered: boolean;
    }
  | { ok: false; code: SelfSignupErrorCode; message: string };

/** Signup attempts allowed per identifier and per IP, and over what window. */
const RATE_LIMIT_WINDOW_SECONDS = 3600;
const MAX_PER_IDENTIFIER = 3;
const MAX_PER_IP = 10;

function normalizeEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function normalizePhone(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Fixed-window counter in Redis. Coarse on purpose: this endpoint is public and
 * creates Keycloak entries, so the point is to make bulk abuse impractical, not
 * to be precise. Fails OPEN — a Redis outage must not block legitimate signup.
 */
async function overLimit(key: string, max: number, log: FastifyBaseLogger): Promise<boolean> {
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
    return count > max;
  } catch (err) {
    log.error({ err, key }, 'self-signup: rate-limit check failed; allowing the request');
    return false;
  }
}

let adminClient: KeycloakAdminClient | null = null;

/** Test seam: forget the memoised admin client. */
export function resetSelfSignupState(): void {
  adminClient = null;
}

function getAdminClient(): KeycloakAdminClient | null {
  if (adminClient) return adminClient;
  if (!keycloakConfig.internal_base_url || !keycloakConfig.api_client_secret) return null;
  adminClient = new KeycloakAdminClient({
    baseUrl: keycloakConfig.internal_base_url,
    realm: keycloakConfig.realm,
    clientId: keycloakConfig.api_client_id,
    clientSecret: keycloakConfig.api_client_secret,
  });
  return adminClient;
}

export async function selfSignup(
  input: SelfSignupInput,
  log: FastifyBaseLogger
): Promise<SelfSignupResult> {
  // Only meaningful when Keycloak is the identity provider. Under `betterauth`
  // the old OTP flow still owns signup.
  if (!authConfig.keycloak_enabled) {
    return {
      ok: false,
      code: 'SIGNUP_NOT_AVAILABLE',
      message: 'This instance does not use Keycloak sign-up.',
    };
  }

  // The same gate provisioning enforces (R2). Checked here too so a gated
  // instance rejects at the door rather than creating a Keycloak shell that
  // could never become a signals user.
  if (!authConfig.allow_self_signup) {
    return {
      ok: false,
      code: 'SELF_SIGNUP_DISABLED',
      message:
        'Self sign-up is disabled on this instance. Please contact your administrator to get onboarded.',
    };
  }

  const email = normalizeEmail(input.email);
  const phoneNumber = normalizePhone(input.phoneNumber);

  if (!email && !phoneNumber) {
    return { ok: false, code: 'NO_IDENTIFIER', message: 'Enter an email or phone number.' };
  }

  const channels = authConfig.login_channels;
  const channelOk =
    (email !== null && channels.includes('email')) ||
    (phoneNumber !== null && channels.includes('phone'));
  if (!channelOk) {
    return {
      ok: false,
      code: 'LOGIN_CHANNEL_DISABLED',
      message: 'That sign-in method is not enabled on this instance.',
    };
  }

  const identifier = email ?? phoneNumber;
  if (
    (await overLimit(`signup:id:${identifier}`, MAX_PER_IDENTIFIER, log)) ||
    (input.clientIp && (await overLimit(`signup:ip:${input.clientIp}`, MAX_PER_IP, log)))
  ) {
    return {
      ok: false,
      code: 'SIGNUP_RATE_LIMITED',
      message: 'Too many sign-up attempts. Please try again later.',
    };
  }

  // A client must not be able to join a domain this instance doesn't serve —
  // `domains` gates profile creation (user_domains.ts), so this is a real check,
  // not input hygiene.
  const domain = input.domain?.trim() || null;
  if (domain && !apiConfig.served_domains.some((binding) => binding.domain === domain)) {
    return {
      ok: false,
      code: 'DOMAIN_NOT_SERVED',
      message: 'That option is not available on this instance.',
    };
  }

  const dateOfBirth = input.dateOfBirth?.trim() || null;
  if (dateOfBirth) {
    const parsed = new Date(dateOfBirth);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() > Date.now()) {
      return {
        ok: false,
        code: 'INVALID_DATE_OF_BIRTH',
        message: 'Enter a valid date of birth.',
      };
    }
  }

  const client = getAdminClient();
  if (!client) {
    log.error('self-signup: KEYCLOAK_API_CLIENT_SECRET is not configured');
    return {
      ok: false,
      code: 'SIGNUP_NOT_AVAILABLE',
      message: 'Sign-up is not available right now.',
    };
  }

  try {
    // Already a signals user? Send them to sign in instead of minting a second
    // identity for the same person.
    const filters = [
      email ? eq(userTable.email, email) : undefined,
      phoneNumber ? eq(userTable.phoneNumber, phoneNumber) : undefined,
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);

    const [localExisting] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(filters.length === 1 ? filters[0] : or(...filters))
      .limit(1);

    if (localExisting) return { ok: true, alreadyRegistered: true };

    // Already in the realm (e.g. an aggregator user, or a previous signup that
    // never completed its first login)? Same answer — never create a duplicate.
    const inRealm = [
      ...(email ? await client.findByEmail(email) : []),
      ...(phoneNumber ? await client.findByPhone(phoneNumber) : []),
    ];
    if (inRealm.length > 0) return { ok: true, alreadyRegistered: true };

    // The id minted here becomes the Keycloak `sub` AND, at first login, the
    // local `user.id` — the same invariant the migration preserves.
    const id = randomUUID();
    const mapped = mapUserToKeycloak({
      id,
      name: input.name?.trim() || 'user',
      email,
      // Unverified until the OTP login proves ownership.
      emailVerified: false,
      phoneNumber,
      phoneNumberVerified: false,
      role: 'user',
      banned: false,
      banReason: null,
      banExpires: null,
    });

    if (!mapped.ok) {
      log.warn({ reason: mapped.message }, 'self-signup: could not map the new user');
      return { ok: false, code: 'NO_IDENTIFIER', message: 'Enter an email or phone number.' };
    }

    // partialImport, not POST /users: KC 26.5.5 ignores a supplied id on plain
    // create, and `sub` must equal what will become the local user.id.
    const outcome = await client.createUserPreservingId(mapped.user);

    switch (outcome.kind) {
      case 'created':
        // Park the signals-only fields for provisioning to apply at first login;
        // there is no local user row to write them to yet. Best-effort — losing
        // them costs a re-selection, and must not fail a created account.
        try {
          await stashSignupExtras(
            { email, phoneNumber },
            { ...(domain ? { domain } : {}), ...(dateOfBirth ? { dateOfBirth } : {}) }
          );
        } catch (err) {
          log.error({ err, user_id: id }, 'self-signup: could not stash signup extras');
        }
        log.info({ user_id: id }, 'self-signup: created a Keycloak identity');
        return { ok: true, alreadyRegistered: false };
      case 'already_exists':
        return { ok: true, alreadyRegistered: true };
      default:
        // A race, or an identifier held by a user the searches above missed.
        log.warn({ detail: 'detail' in outcome ? outcome.detail : outcome.kind },
          'self-signup: Keycloak refused to create the identity');
        return { ok: true, alreadyRegistered: true };
    }
  } catch (err) {
    log.error({ err }, 'self-signup failed');
    return { ok: false, code: 'SIGNUP_FAILED', message: 'Could not complete sign-up.' };
  }
}
