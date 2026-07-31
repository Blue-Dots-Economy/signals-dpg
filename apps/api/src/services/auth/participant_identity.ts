/**
 * Keycloak identity creation for admin-onboarded participants.
 *
 * The missing half of `POST /api/v1/admin/participant`. That route creates the
 * local `user` row (today via better-auth's `signUpEmail`), but under Keycloak
 * a local row is not an account: login goes through the realm's OTP flow, whose
 * `IdentifierFormAuthenticator` is **login-only** and fails with
 * `user_not_found` when no realm user owns the identifier. So a participant
 * onboarded by an aggregator got a signals row and no way to ever sign in.
 *
 * Worse, they could not self-rescue either — `selfSignup` sees the existing
 * local row and returns `alreadyRegistered: true` without creating anything in
 * Keycloak, so "sign in" said *user not found* and "sign up" said *already
 * registered*.
 *
 * This module closes that gap by mirroring what `self_signup.ts` already does
 * for the public path: create the realm identity with the id signals chose, via
 * `partialImport`. The invariant that matters is
 *
 *     keycloak user.id == sub == signals user.id
 *
 * because `items.created_by` and every `*_owner` text column key on that id
 * (see the migration design §2.3/§6.1). `POST /users` is unusable here: on
 * Keycloak 26.5.5 it ignores a client-supplied id and mints its own.
 *
 * **Fails closed.** A participant with no realm identity cannot log in, so a
 * failure here is reported to the caller rather than logged and swallowed —
 * silently creating an unusable account is the bug being fixed.
 */

import type { FastifyBaseLogger } from 'fastify';
import { authConfig, keycloakConfig } from '@/config';
import { KeycloakAdminClient } from '@/services/auth/keycloak_admin';
import { mapUserToKeycloak } from '@/services/auth/user_to_keycloak';

/** Why a participant's realm identity could not be created. */
export type ParticipantIdentityErrorCode =
  /** A Keycloak mode is active but the admin client is not configured. */
  | 'IDENTITY_PROVIDER_NOT_CONFIGURED'
  /** The row carries neither an email nor a phone, so it has no username. */
  | 'NO_IDENTIFIER'
  /** Another realm user already owns these identifiers. */
  | 'IDENTITY_CONFLICT'
  /** Keycloak rejected the import, or the id did not survive it. */
  | 'IDENTITY_CREATE_FAILED';

export type ParticipantIdentityResult =
  | {
      ok: true;
      /**
       * False when this instance runs `AUTH_PROVIDER=betterauth`, where there
       * is no realm to create anything in and the better-auth row IS the
       * account. Callers use this only for logging.
       */
      created: boolean;
    }
  | { ok: false; code: ParticipantIdentityErrorCode; message: string };

/** Everything needed to mint the realm identity for an onboarded participant. */
export interface ParticipantIdentityInput {
  /** The signals `user.id`. Becomes the Keycloak `sub`, unchanged. */
  userId: string;
  name: string;
  email: string | null;
  /** E.164, already normalised by the route. Drives the phone OTP channel. */
  phoneNumber: string | null;
  log: FastifyBaseLogger;
}

let adminClient: KeycloakAdminClient | null = null;

/** Test seam: forget the memoised admin client. */
export function resetParticipantIdentityState(): void {
  adminClient = null;
}

function getAdminClient(): KeycloakAdminClient | null {
  if (adminClient) return adminClient;
  if (!keycloakConfig.internal_base_url || !keycloakConfig.api_client_secret) {
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

/**
 * Creates the Keycloak identity for an already-written signals `user` row.
 *
 * Idempotent: an identity already carrying `userId` is reported as success, so
 * a retried onboard does not fail on its own previous work.
 *
 * @param input - The signals user id plus the identifiers to key the realm user on.
 * @returns `ok` with `created` false under `AUTH_PROVIDER=betterauth` (nothing
 *   to do), `ok` with `created` true once the realm user exists, or a typed
 *   failure the caller must surface — never a silent partial success.
 */
export async function createParticipantKeycloakIdentity(
  input: ParticipantIdentityInput,
): Promise<ParticipantIdentityResult> {
  // Under `betterauth` there is no realm to write into and the better-auth row
  // is the account. Both `dual` and `keycloak` need the identity: `dual`'s
  // straggler backfill only fires on a better-auth *login*, which an
  // aggregator-onboarded participant never performs.
  if (!authConfig.keycloak_enabled) return { ok: true, created: false };

  const client = getAdminClient();
  if (!client) {
    input.log.error(
      { user_id: input.userId },
      'participant identity: KEYCLOAK_API_CLIENT_SECRET is not configured, so the ' +
        'realm identity cannot be created and the participant could never log in',
    );
    return {
      ok: false,
      code: 'IDENTITY_PROVIDER_NOT_CONFIGURED',
      message: 'Keycloak is not configured for user administration on this instance',
    };
  }

  const mapped = mapUserToKeycloak({
    id: input.userId,
    name: input.name,
    email: input.email,
    // Onboarding by an aggregator proves nothing about the identifier; the OTP
    // login is what verifies it. Same stance as `self_signup.ts`.
    emailVerified: false,
    phoneNumber: input.phoneNumber,
    phoneNumberVerified: false,
    role: 'user',
    banned: false,
    banReason: null,
    banExpires: null,
  });

  if (!mapped.ok) {
    input.log.warn(
      { user_id: input.userId, reason: mapped.message },
      'participant identity: could not map the user for Keycloak',
    );
    return { ok: false, code: 'NO_IDENTIFIER', message: mapped.message };
  }

  const start = Date.now();
  try {
    const outcome = await client.createUserPreservingId(mapped.user);

    switch (outcome.kind) {
      case 'created':
        input.log.info({
          operation: 'createParticipantKeycloakIdentity',
          status: 'success',
          latency_ms: Date.now() - start,
          user_id: input.userId,
        });
        return { ok: true, created: true };

      case 'already_exists':
        // A retry, or the migration script got here first. The id matches, so
        // the invariant holds and there is nothing to do.
        input.log.info({
          operation: 'createParticipantKeycloakIdentity',
          status: 'skipped',
          latency_ms: Date.now() - start,
          user_id: input.userId,
        });
        return { ok: true, created: false };

      case 'created_with_different_id':
        // Must not happen on the partialImport path, but if the transport ever
        // regresses to POST /users this is the invariant break — report it.
        input.log.error({
          operation: 'createParticipantKeycloakIdentity',
          status: 'failure',
          latency_ms: Date.now() - start,
          user_id: input.userId,
          error: `Keycloak assigned id ${outcome.assignedId}`,
          error_type: 'IdPreservationFailed',
        });
        return {
          ok: false,
          code: 'IDENTITY_CREATE_FAILED',
          message: 'Keycloak did not preserve the user id',
        };

      case 'conflict': {
        input.log.error({
          operation: 'createParticipantKeycloakIdentity',
          status: 'failure',
          latency_ms: Date.now() - start,
          user_id: input.userId,
          error: outcome.detail,
          error_type: 'IdentityConflict',
        });
        return {
          ok: false,
          code: 'IDENTITY_CONFLICT',
          message: 'Another account already owns this email or phone number',
        };
      }
    }
  } catch (err) {
    input.log.error({
      operation: 'createParticipantKeycloakIdentity',
      status: 'failure',
      latency_ms: Date.now() - start,
      user_id: input.userId,
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof Error ? err.constructor.name : 'Unknown',
    });
    return {
      ok: false,
      code: 'IDENTITY_CREATE_FAILED',
      message: 'Could not reach Keycloak to create the participant identity',
    };
  }
}
