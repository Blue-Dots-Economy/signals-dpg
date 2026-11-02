/**
 * Bulk-migrate signals `user` rows into Keycloak, preserving UUIDs.
 *
 * Design: docs/superpowers/plans/2026-07-23-keycloak-migration-design.md.
 *
 * Login is passwordless OTP, so there are no credentials to migrate: the job
 * is an identity shell per user with the right id, attributes and verified
 * flags. The invariant is
 *
 *     keycloak user.id == sub == signals user.id
 *
 * which keeps `items.created_by` and every `*_owner` column pointing at the
 * right identity without touching a partition.
 *
 * This file is the thin CLI shell (env, args, pg pool, SQL data access); every
 * migration decision lives in the unit-tested core
 * (`src/services/auth/migrate_core.ts`).
 *
 * Modes:
 *   --probe             Check against THIS Keycloak whether POST /users
 *                       honours a client-supplied id. Creates
 *                       and deletes one throwaway user. Run this first.
 *   (default)           Dry run: report what would happen. Writes nothing.
 *   --apply             Actually create the users.
 *   --reconcile         Verify every local user has a Keycloak match by id.
 *
 * Options:
 *   --strategy=create|import   Transport. `create` is POST /users; `import` is
 *                              partialImport, the fallback when create will not
 *                              honour the id. Default: create.
 *   --batch=<n>                partialImport batch size (default 100).
 *   --limit=<n>                Process at most n users (for a canary run).
 *   --env-path=<path>          Read this .env instead of searching. Relative to
 *                              the current directory. Not `--env-file`:
 *                              tsx hoists that Node flag to node, so it never
 *                              reaches this script.
 *
 * Run:
 *   cd apps/api
 *   pnpm tsx scripts/migrate_users_to_keycloak.ts --probe
 *   pnpm tsx scripts/migrate_users_to_keycloak.ts               # dry run
 *   pnpm tsx scripts/migrate_users_to_keycloak.ts --apply
 *   pnpm tsx scripts/migrate_users_to_keycloak.ts --reconcile
 *
 * Idempotent: a user that already exists in Keycloak under the same id is
 * skipped, so a partial run can simply be re-run.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import dotenv from 'dotenv';

/**
 * Environment resolution, in priority order:
 *   1. the real process environment (always wins)
 *   2. `--env-path=<path>`, if given
 *   3. the first of the repo's known .env locations that exists
 *
 * `override: false` is explicit: getting it wrong would silently prefer a stale
 * local file over the deployment's own secrets. Paths resolve from the script's
 * location, not `process.cwd()`.
 */
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');

function loadEnvFile(): void {
  const explicit = process.argv
    .find((a) => a.startsWith('--env-path='))
    ?.split('=')
    .slice(1)
    .join('=');

  const candidates = explicit
    ? [resolve(process.cwd(), explicit)]
    : [resolve(repoRoot, '.env'), resolve(repoRoot, 'local-setup/.env')];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    dotenv.config({ path, override: false });
    console.log(`env: loaded ${path} (process env still wins)`);
    return;
  }
  if (explicit) {
    console.error(`env: --env-path not found: ${candidates[0]}`);
    process.exit(2);
  }
  console.log('env: no .env file found — using the process environment only');
}

loadEnvFile();

// Own pg pool + drizzle rather than the API's drizzle_config, which runs the
// full Zod env validation a standalone script should not need.
const pgUrl =
  process.env.POSTGRES_URL ??
  `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST ?? '127.0.0.1'}:${process.env.POSTGRES_PORT ?? process.env.DATABASE_PORT ?? '5432'}/${process.env.POSTGRES_DB}`;

const pool = new Pool({ connectionString: pgUrl, ssl: false });
const db = drizzle(pool);

import { member, user as userTable } from '../db/postgres/schema/auth.js';
import {
  KeycloakAdminClient,
  type KeycloakAdminConfig,
} from '../src/services/auth/keycloak_admin.js';
import type { SignalsUserRow } from '../src/services/auth/user_to_keycloak.js';
import {
  runMigration,
  runReconcile,
  runProbe,
  type MigrationData,
  type MigrationOptions,
} from '../src/services/auth/migrate_core.js';


const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const value = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const MODE = has('--probe')
  ? 'probe'
  : has('--reconcile')
    ? 'reconcile'
    : has('--apply')
      ? 'apply'
      : 'dry-run';

const OPTS: MigrationOptions = {
  strategy: value('strategy') === 'import' ? 'import' : 'create',
  batch: Number(value('batch') ?? 100),
  limit: value('limit') ? Number(value('limit')) : undefined,
};


function loadKeycloakConfig(): KeycloakAdminConfig {
  const baseUrl = (
    process.env.KEYCLOAK_INTERNAL_BASE_URL ??
    process.env.KEYCLOAK_BASE_URL ??
    ''
  ).replace(/\/$/, '');
  const realm = process.env.KEYCLOAK_REALM ?? 'bluedots';
  const clientId = process.env.KEYCLOAK_API_CLIENT_ID ?? 'signals-api';
  const clientSecret = process.env.KEYCLOAK_API_CLIENT_SECRET ?? '';

  const missing: string[] = [];
  if (!baseUrl) missing.push('KEYCLOAK_BASE_URL (or KEYCLOAK_INTERNAL_BASE_URL)');
  if (!clientSecret) missing.push('KEYCLOAK_API_CLIENT_SECRET');
  if (missing.length) {
    console.error(`missing required env: ${missing.join(', ')}`);
    process.exit(2);
  }
  return { baseUrl, realm, clientId, clientSecret };
}


const data: MigrationData = {
  /**
   * Every human. Service users (a `member.role='service'` row) are excluded:
   * each integrating DPG's identity is a Keycloak client, and a user shell
   * would collide with its client-credentials service account.
   */
  async fetchHumanUsers(limit?: number): Promise<SignalsUserRow[]> {
    const serviceUserIds = db
      .select({ userId: member.userId })
      .from(member)
      .where(eq(member.role, 'service'));

    return db
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
      .where(sql`${userTable.id} NOT IN ${serviceUserIds}`)
      .orderBy(userTable.createdAt)
      .limit(limit ?? 1_000_000);
  },

  async countServiceUsers(): Promise<number> {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(member)
      .where(eq(member.role, 'service'));
    return rows[0]?.n ?? 0;
  },

};


const main = async (): Promise<number> => {
  const client = new KeycloakAdminClient(loadKeycloakConfig());
  switch (MODE) {
    case 'probe':
      return (await runProbe(client)).code;
    case 'reconcile':
      return (await runReconcile(client, data, OPTS)).code;
    case 'apply':
      return (await runMigration(client, data, OPTS, true)).code;
    default:
      return (await runMigration(client, data, OPTS, false)).code;
  }
};

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('migration failed:', err instanceof Error ? err.message : String(err));
    await pool.end();
    process.exit(1);
  });
