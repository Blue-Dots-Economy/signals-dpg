/**
 * The one place a local `user` row is created.
 *
 * Extracted from `provisioning.ts`'s `createMirror` so that admin onboarding
 * (`routes/v1/admin/participant.ts`) can stop creating its user through
 * better-auth's `signUpEmail` and write the row directly instead. Two hand-rolled
 * inserts would drift — over the columns, over the 23505 race handling, or over
 * which of them remembered `updatedAt` — so there is exactly one.
 *
 * Phase 2 of docs/superpowers/plans/2026-07-31-replace-better-auth-with-keycloak.md.
 *
 * **What this deliberately does not do:** write an `account` row, set a password,
 * or synthesise an email. Those are `signUpEmail` artifacts, not requirements —
 * `user.email` is nullable, and a phone-only participant should simply have no
 * email rather than a `<uuid>@no-email.local` address that nothing can deliver to
 * and no lookup can ever match.
 */

import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { user as userTable } from '@api/db/postgres/schema/auth';

/** Postgres unique-violation. Concurrent creates surface as this. */
const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

/**
 * Just the query surface this module uses, so a caller can hand in either the
 * shared `db` handle or a transaction — the admin-onboarding path needs the
 * insert to roll back with the profile-item creation beside it.
 */
export type UserWriteExecutor = Pick<typeof db, 'insert' | 'select'>;

/**
 * A bare RFC-4122 UUID. Keycloak generates ids in this shape and the migration
 * script preserves them, so this is an invariant check rather than a conversion.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LocalUserInsert {
  /**
   * The row's primary key, which **is** the Keycloak `sub`
   * (`keycloak user.id == sub == signals user.id`, design §2.3/§6.1). Must be a
   * bare UUID: `items.created_by` and every `*_owner` column key on it, and a
   * prefixed id (the `usr_` form `seed_service_users.ts` uses for service
   * accounts, which never log in through Keycloak) would break the round trip.
   */
  id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
  /**
   * Columns the caller owns. First-login provisioning sets the consent booleans
   * here; admin onboarding instead supplies its onboarding attribution, age and
   * domains — and deliberately leaves the consent booleans alone, because
   * consent lives in the ledger since #309.
   */
  extra?: Partial<typeof userTable.$inferInsert>;
}

export type LocalUserWriteResult =
  | { ok: true; created: true; id: string }
  /**
   * A concurrent caller won the race and the row already existed. The row it
   * wrote is returned so the caller can answer from it rather than re-reading.
   */
  | { ok: true; created: false; id: string; existing: typeof userTable.$inferSelect }
  | { ok: false; code: 'IDENTITY_CONFLICT' | 'USER_WRITE_FAILED'; message: string };

/**
 * Insert the local `user` row.
 *
 * Defaults (`role`, `image`, `banned`, `banReason`, `banExpires`, the timestamps)
 * were read off the rows the two existing paths actually produced, so neither
 * caller's row shape changes.
 *
 * @param input - Identity columns, plus any caller-owned columns via `extra`.
 * @param log - Used for the race warning and the unexpected-failure error.
 * @param exec - Transaction handle, when the insert must roll back with adjacent
 *   work. Defaults to the shared `db`.
 * @returns `created: true` on a fresh insert; `created: false` plus the winning
 *   row when a concurrent caller got there first; `IDENTITY_CONFLICT` when the
 *   identifiers belong to a *different* row; `USER_WRITE_FAILED` otherwise.
 *   Never throws for an expected failure.
 */
export async function insertLocalUser(
  input: LocalUserInsert,
  log: FastifyBaseLogger,
  exec: UserWriteExecutor = db
): Promise<LocalUserWriteResult> {
  if (!UUID_RE.test(input.id)) {
    // Failing loudly beats writing a row whose id cannot be a Keycloak subject:
    // that user could never log in, and the breakage would surface much later as
    // orphaned domain data.
    log.error(
      { user_id: input.id },
      'user_writer: refusing to insert a user whose id is not a bare UUID',
    );
    return {
      ok: false,
      code: 'USER_WRITE_FAILED',
      message: 'The user id must be a bare UUID to serve as the Keycloak subject',
    };
  }

  const now = new Date();

  try {
    await exec.insert(userTable).values({
      id: input.id,
      name: input.name,
      email: input.email,
      emailVerified: input.emailVerified,
      phoneNumber: input.phoneNumber,
      phoneNumberVerified: input.phoneNumberVerified,
      image: '',
      role: 'user',
      banned: false,
      banReason: '',
      banExpires: null,
      createdAt: now,
      updatedAt: now,
      ...input.extra,
    });
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      log.warn({ user_id: input.id }, 'user_writer: concurrent create, re-reading');
      const [row] = await exec
        .select()
        .from(userTable)
        .where(eq(userTable.id, input.id))
        .limit(1);

      if (row) return { ok: true, created: false, id: row.id, existing: row };

      // The violation was on `email` or `phone_number`, not the primary key — a
      // *different* row already holds these identifiers. Never merge or re-key:
      // that would repoint domain data, which this design exists to avoid.
      return {
        ok: false,
        code: 'IDENTITY_CONFLICT',
        message:
          'This email or phone number is already registered under a different account.',
      };
    }

    log.error({ err, user_id: input.id }, 'user_writer: failed to insert the user row');
    return {
      ok: false,
      code: 'USER_WRITE_FAILED',
      message: 'Could not create the local user record',
    };
  }

  return { ok: true, created: true, id: input.id };
}
