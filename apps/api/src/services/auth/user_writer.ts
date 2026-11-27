/**
 * The one place a local `user` row is created, shared by first-login
 * provisioning (`provisioning.ts`) and admin onboarding
 * (`routes/v1/admin/participant.ts`) so columns and 23505 race handling cannot
 * drift between them.
 *
 * No `account` row, password or synthesised email is written: `user.email` is
 * nullable, and a phone-only participant has no email.
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
 * The query surface this module uses, so a caller can pass `db` or a
 * transaction (admin onboarding rolls the insert back with the profile item).
 */
export type UserWriteExecutor = Pick<typeof db, 'insert' | 'select'>;

/** A bare UUID, the shape Keycloak ids take. An invariant check, not a conversion. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LocalUserInsert {
  /**
   * The row's primary key, which is the Keycloak `sub`. Must be a bare UUID:
   * `items.created_by` and every `*_owner` column key on it, and a prefixed id
   * (the `usr_` form `seed_service_users.ts` uses for service accounts) could
   * never be a Keycloak subject.
   */
  id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
  /**
   * Columns the caller owns. First-login provisioning sets the consent booleans
   * here; admin onboarding supplies onboarding attribution, age and domains and
   * leaves the consent booleans alone, because consent lives in the ledger.
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
 * @param exec - Transaction handle, when the insert must roll back with adjacent
 *   work. Defaults to the shared `db`.
 * @returns `created: true` on a fresh insert; `created: false` plus the winning
 *   row when a concurrent caller got there first; `IDENTITY_CONFLICT` when the
 *   identifiers belong to a different row; `USER_WRITE_FAILED` otherwise.
 *   Never throws for an expected failure.
 */
export async function insertLocalUser(
  input: LocalUserInsert,
  log: FastifyBaseLogger,
  exec: UserWriteExecutor = db
): Promise<LocalUserWriteResult> {
  if (!UUID_RE.test(input.id)) {
    // A row whose id cannot be a Keycloak subject could never log in.
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

      // The violation was on `email` or `phone_number`: a different row holds
      // these identifiers. Never merge or re-key; that would repoint domain data.
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
