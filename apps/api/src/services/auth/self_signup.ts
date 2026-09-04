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
  /** Age in years (0..120), derived from the birth year on the client (#331). Parked for provisioning to apply at first login. */
  age?: number | null;
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
  | 'INVALID_AGE'
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
 *
 * WHY THIS EXISTS IN THE APP AT ALL, given Kong rate-limits at the ingress
 * (signals-dpg#669). Rate limiting is otherwise deployment config, not
 * application code — the per-route per-IP ceilings live in the signals api
 * chart's `apiRateLimit.groups`, and CodeQL's `js/missing-rate-limiting` on the
 * other routes is answered by that, not by adding limiters here.
 *
 * The one exception is the per-IDENTIFIER limit below. Kong's rate-limiting
 * plugin keys on ip / credential / consumer / service / header / path — it
 * cannot key on a field in the request body, and the signup identifier is the
 * email/phone in the POST body. So "N attempts per identifier" is not
 * expressible at the ingress at any setting, and this is the only place it can
 * live.
 *
 * There is deliberately NO per-IP counter here any more. Per-IP is precisely
 * what Kong's `apiRateLimit` does, keyed on the PROXY-protocol address the L4
 * ELB prepends — which a client cannot forge, unlike the X-Forwarded-For that
 * Fastify's `request.ip` ultimately trusts — and counted in shared Redis so the
 * ceiling holds across proxy replicas. An in-process per-IP counter was a
 * weaker duplicate of a control that already exists one layer up, so it was
 * removed rather than made operator-tunable.
 *
 * The TTL is stamped only on the first increment of a window, which matters now
 * that `windowSeconds` is operator-tunable: RAISING a max takes effect on the
 * next request, but SHORTENING the window does not retroactively shorten keys
 * already counting. An operator who cuts the window from 3600 to 300 to release
 * someone still has to wait out (or DEL) the existing key. Left as a fixed
 * window deliberately — re-stamping on every increment would turn it into a
 * sliding window and change the abuse ceiling's meaning, which is not this
 * change's job.
 */
async function overLimit(
  key: string,
  max: number,
  windowSeconds: number,
  log: FastifyBaseLogger,
): Promise<boolean> {
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds);
    return count > max;
  } catch (err) {
    log.error({ err, key }, 'self-signup: rate-limit check failed; allowing the request');
    return false;
  }
}

let adminClient: KeycloakAdminClient | null = null;

/**
 * Whether the realm retains a written `phoneNumber` attribute, memoised.
 *
 * The realm's user profile is deploy-time configuration, not per-request state,
 * so one check per process is enough — and it must be memoised, because this
 * endpoint is public and would otherwise turn every signup into an extra
 * Admin-REST round trip. A failed check is not cached (stays null), so a
 * transient Keycloak blip does not disable phone signup for the process
 * lifetime.
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

/** Every up-front guard, in the order the endpoint has always applied them. */
async function prepareSignup(
  input: SelfSignupInput,
  log: FastifyBaseLogger
): Promise<PreparedSignup | SignupRejection> {
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
  // Read at request time, not module scope: the limits are operator-tunable
  // (SIGNUP_MAX_PER_IDENTIFIER / SIGNUP_RATE_LIMIT_WINDOW_SECONDS) and reading
  // them here keeps this file free of import-time config evaluation.
  const { window_seconds, max_per_identifier } = authConfig.signup_rate_limit;
  if (await overLimit(`signup:id:${identifier}`, max_per_identifier, window_seconds, log)) {
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
 * A phone-only user whose `phoneNumber` attribute is silently dropped by the
 * realm is created and then permanently unable to receive an OTP — the same
 * false green the migration script guards against (`attributesWillPersist`),
 * which live signup was missing. Refuse before creating rather than mint an
 * account nobody can log into.
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

  // The id minted here becomes the Keycloak `sub` AND, at first login, the
  // local `user.id` — the same invariant the migration preserves.
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
      // Creation failed and the pre-checks above found nothing, so this is
      // either a race (someone claimed the identifier in between) or a real
      // failure. Look again before answering: reporting `alreadyRegistered`
      // unconditionally is the exact "sign-up says registered / sign-in says
      // no such user" dead-end this migration exists to remove, and the user
      // has no way out of it. Only a re-check that actually finds the
      // identifier justifies that answer.
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
