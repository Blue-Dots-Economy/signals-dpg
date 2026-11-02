/**
 * Self-signup under Keycloak. The Keycloak OTP authenticator is login-only (it
 * fails with `user_not_found` and cannot create users), and Keycloak's own
 * registration form is password-based, so signals creates the identity and
 * then hands the browser to Keycloak to authenticate it:
 *
 *   1. here: mint the UUID and create the unverified Keycloak identity
 *   2. Keycloak: prove ownership of the identifier via the OTP flow
 *   3. `provisionUserFromClaims`: create the local `user` mirror on first login
 *
 * No local `user` row is written here: until an OTP login succeeds there is no
 * proof of ownership, so an abandoned or malicious signup leaves only an
 * unverified Keycloak identity. The optional `domain` and `age` are parked in
 * Redis (signup_extras.ts) for provisioning to apply at first login.
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
  /** Age in years (0..120), derived from the birth year on the client. Parked for provisioning to apply at first login. */
  age?: number | null;
  /** Caller IP, for rate limiting. */
  clientIp?: string;
}

export type SelfSignupErrorCode =
  /** No Keycloak admin client is configured, or the realm drops `phoneNumber` for a phone signup. */
  | 'SIGNUP_NOT_AVAILABLE'
  /** SELF_SIGNUP_MODE=gated — participants are admin-onboarded. */
  | 'SELF_SIGNUP_DISABLED'
  | 'NO_IDENTIFIER'
  | 'LOGIN_CHANNEL_DISABLED'
  | 'SIGNUP_RATE_LIMITED'
  /** Domain isn't one this instance serves. */
  | 'DOMAIN_NOT_SERVED'
  | 'INVALID_AGE'
  | 'SIGNUP_FAILED';

export type SelfSignupResult =
  | {
      ok: true;
      /**
       * True when the identifier already belongs to someone. Reported as success
       * so the UI can send them to sign in.
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
  return trimmed || null;
}

function normalizePhone(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
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

/**
 * Whether the realm retains a written `phoneNumber` attribute, memoised per
 * process: the realm user profile is deploy-time config, and this public
 * endpoint should not add an Admin-REST round trip per signup. A check that
 * throws leaves it null, so a transient Keycloak error does not disable phone
 * signup for the process lifetime.
 */
let phoneAttributePersists: boolean | null = null;

/** Test seam: forget the memoised admin client and realm-profile probe. */
export function resetSelfSignupState(): void {
  adminClient = null;
  phoneAttributePersists = null;
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

/** The validated inputs a signup proceeds with once every guard has passed. */
interface PreparedSignup {
  ok: true;
  email: string | null;
  phoneNumber: string | null;
  domain: string | null;
  age: number | null;
  client: KeycloakAdminClient;
}

type SignupRejection = Extract<SelfSignupResult, { ok: false }>;

/** Every up-front guard, in order. */
async function prepareSignup(
  input: SelfSignupInput,
  log: FastifyBaseLogger
): Promise<PreparedSignup | SignupRejection> {
  if (!authConfig.keycloak_enabled) {
    return {
      ok: false,
      code: 'SIGNUP_NOT_AVAILABLE',
      message: 'This instance does not use Keycloak sign-up.',
    };
  }

  // Provisioning enforces the same gate; checking here too stops a gated
  // instance creating a Keycloak identity that could never become a signals user.
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

  // `domains` gates profile creation, so a client must not join a domain this
  // instance doesn't serve.
  const domain = input.domain?.trim() || null;
  if (domain && !apiConfig.served_domains.some((binding) => binding.domain === domain)) {
    return {
      ok: false,
      code: 'DOMAIN_NOT_SERVED',
      message: 'That option is not available on this instance.',
    };
  }

  const age = typeof input.age === 'number' ? input.age : null;
  if (age !== null && (!Number.isInteger(age) || age < 0 || age > 120)) {
    return {
      ok: false,
      code: 'INVALID_AGE',
      message: 'Enter a valid age.',
    };
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

  return { ok: true, email, phoneNumber, domain, age, client };
}

/** Realm users holding this email or phone (either lookup may be skipped). */
async function findInRealm(
  client: KeycloakAdminClient,
  email: string | null,
  phoneNumber: string | null
) {
  return [
    ...(email ? await client.findByEmail(email) : []),
    ...(phoneNumber ? await client.findByPhone(phoneNumber) : []),
  ];
}

/** True when the identifier already belongs to a signals user or realm user. */
async function identifierAlreadyKnown(
  client: KeycloakAdminClient,
  email: string | null,
  phoneNumber: string | null
): Promise<boolean> {
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

  if (localExisting) return true;

  // Already in the realm (e.g. an aggregator user, or a previous signup that
  // never completed its first login)? Same answer — never create a duplicate.
  const inRealm = await findInRealm(client, email, phoneNumber);
  return inRealm.length > 0;
}

/**
 * If the realm silently drops `phoneNumber`, a phone user would be created but
 * never receive an OTP. Refuse before creating rather than mint an account
 * nobody can log into.
 */
async function phoneAttributeWillPersist(
  client: KeycloakAdminClient,
  log: FastifyBaseLogger
): Promise<boolean> {
  phoneAttributePersists ??= await client.attributesWillPersist('phoneNumber');
  if (!phoneAttributePersists) {
    log.error(
      'self-signup: the realm does not retain the phoneNumber attribute — ' +
        'declare it in the user profile or enable unmanaged attributes, or ' +
        'phone sign-ups can never receive an OTP'
    );
  }
  return phoneAttributePersists;
}

/** Mints the identity in the realm and classifies Keycloak's answer. */
async function createRealmIdentity(
  prepared: PreparedSignup,
  name: string | undefined,
  log: FastifyBaseLogger
): Promise<SelfSignupResult> {
  const { client, email, phoneNumber, domain, age } = prepared;

  // The id minted here becomes the Keycloak `sub` and, at first login, the
  // local `user.id`.
  const id = randomUUID();
  const mapped = mapUserToKeycloak({
    id,
    name: name?.trim() || 'user',
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
          { ...(domain ? { domain } : {}), ...(age !== null ? { age } : {}) }
        );
      } catch (err) {
        log.error({ err, user_id: id }, 'self-signup: could not stash signup extras');
      }
      log.info({ user_id: id }, 'self-signup: created a Keycloak identity');
      return { ok: true, alreadyRegistered: false };
    case 'already_exists':
      return { ok: true, alreadyRegistered: true };
    default: {
      // Creation failed and the pre-checks found nothing: either a race or a
      // real failure. Re-check before answering `alreadyRegistered`, otherwise
      // the user is told "registered" at sign-up and "no such user" at sign-in.
      log.warn(
        { detail: 'detail' in outcome ? outcome.detail : outcome.kind },
        'self-signup: Keycloak refused to create the identity'
      );

      const nowInRealm = await findInRealm(client, email, phoneNumber);
      if (nowInRealm.length > 0) return { ok: true, alreadyRegistered: true };

      log.error(
        { detail: 'detail' in outcome ? outcome.detail : outcome.kind },
        'self-signup: identity was neither created nor found on re-check'
      );
      return { ok: false, code: 'SIGNUP_FAILED', message: 'Could not complete sign-up.' };
    }
  }
}

export async function selfSignup(
  input: SelfSignupInput,
  log: FastifyBaseLogger
): Promise<SelfSignupResult> {
  const prepared = await prepareSignup(input, log);
  if (!prepared.ok) return prepared;

  try {
    if (await identifierAlreadyKnown(prepared.client, prepared.email, prepared.phoneNumber)) {
      return { ok: true, alreadyRegistered: true };
    }

    if (prepared.phoneNumber && !(await phoneAttributeWillPersist(prepared.client, log))) {
      return {
        ok: false,
        code: 'SIGNUP_NOT_AVAILABLE',
        message: 'Sign-up is not available right now.',
      };
    }

    return await createRealmIdentity(prepared, input.name, log);
  } catch (err) {
    log.error({ err }, 'self-signup failed');
    return { ok: false, code: 'SIGNUP_FAILED', message: 'Could not complete sign-up.' };
  }
}
