/**
 * Keycloak identity creation for admin-onboarded participants.
 *
 * `POST /api/v1/admin/participant` writes the local `user` row
 * (`insertLocalUser`), but login goes through the realm's OTP flow, which
 * fails with `user_not_found` when no realm user owns the identifier, and
 * `selfSignup` would answer `alreadyRegistered` for the local row. So the
 * realm identity is created here with the id signals chose, via
 * `partialImport`, keeping `keycloak user.id == sub == signals user.id`
 * (`items.created_by` and every `*_owner` column key on it).
 *
 * Fails closed: a participant with no realm identity cannot log in, so a
 * failure is returned to the caller, not logged and swallowed.
 */

import type { FastifyBaseLogger } from 'fastify';
import { authConfig, keycloakConfig } from '@/config';
import { KeycloakAdminClient } from '@/services/auth/keycloak_admin';
import { mapUserToKeycloak } from '@/services/auth/user_to_keycloak';

/** Why a participant's realm identity could not be created. */
export type ParticipantIdentityErrorCode =
  /** The Keycloak admin client is not configured. */
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
      /** False when the realm identity already existed. Callers use this only for logging. */
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
 * Idempotent: an identity already carrying `userId` is reported as success
 * (`created: false`), so a retried onboard does not fail on its own previous
 * work. Any other failure is a typed result the caller must surface.
 */
export async function createParticipantKeycloakIdentity(
  input: ParticipantIdentityInput,
): Promise<ParticipantIdentityResult> {
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
    // login verifies it.
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
        // A retry, or the migration script got here first. The id matches.
        input.log.info({
          operation: 'createParticipantKeycloakIdentity',
          status: 'skipped',
          latency_ms: Date.now() - start,
          user_id: input.userId,
        });
        return { ok: true, created: false };

      case 'created_with_different_id':
        // Not expected on the partialImport path; reported because it breaks
        // `sub == user.id`.
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
