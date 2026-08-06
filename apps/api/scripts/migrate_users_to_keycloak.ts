/**
 * Bulk-migrate signals `user` rows into Keycloak, preserving UUIDs.
 *
 * Rollout step R4 of docs/superpowers/plans/2026-07-23-keycloak-migration-design.md.
 * Merging this script changes nothing — it only does something when run.
 *
 * Because login is passwordless OTP there are no credentials to migrate: the
 * job is to create an identity *shell* per user with the right id, attributes
 * and verified flags (§6.2). The one invariant that matters is
 *
 *     keycloak user.id == sub == signals user.id
 *
 * which is what keeps `items.created_by` and every `*_owner` text column
 * pointing at the right identity without touching a single partition (§2.3).
 *
 * This file is the **thin CLI shell**: env + args + a pg pool + the SQL
 * data-access object. Every migration *decision* lives in the injected,
 * unit-tested core (`src/services/auth/migrate_core.ts`).
 *
 * ── Modes ──────────────────────────────────────────────────────────────────
 *   --probe             Answer the §6.3 spike-1 question against THIS Keycloak:
 *                       does POST /users honour a client-supplied id? Creates
 *                       and deletes one throwaway user. Run this first.
 *   --audit-passwords   Risk R6: report whether any real password accounts
 *                       exist, which the no-credentials assumption relies on.
 *   (default)           Dry run: report what would happen. Writes nothing.
 *   --apply             Actually create the users.
 *   --reconcile         Verify every local user has a Keycloak match by id.
 *
 * ── Options ────────────────────────────────────────────────────────────────
 *   --strategy=create|import   Transport. `create` is POST /users; `import` is
 *                              partialImport, the fallback when create will not
 *                              honour the id. Default: create.
 *   --batch=<n>                partialImport batch size (default 100).
 *   --limit=<n>                Process at most n users (for a canary run).
 *   --env-path=<path>          Read this .env instead of searching. Relative to
 *                              the current directory. Deliberately NOT
 *                              `--env-file`: that is a Node flag (>=20.6) which
 *                              tsx hoists to node, so it never reaches this
 *                              script — node just fails on a missing path.
 *
 * ── Run ────────────────────────────────────────────────────────────────────
 *   cd apps/api
 *   pnpm tsx scripts/migrate_users_to_keycloak.ts --probe
 *   pnpm tsx scripts/migrate_users_to_keycloak.ts --audit-passwords
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
 *   1. the real process environment — ALWAYS wins
 *   2. `--env-path=<path>`, if given
 *   3. the first of the repo's known .env locations that exists
 *
 * `override: false` (the default) is stated explicitly because getting it wrong
 * would silently prefer a stale local file over the deployment's own secrets.
 * Paths resolve from the SCRIPT's location, not `process.cwd()`.
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

// Own pg pool + drizzle handle rather than importing the API's drizzle_config,
// which transitively runs the API's full Zod env validation. A standalone
// script should not require app-context env vars.
const pgUrl =
  process.env.POSTGRES_URL ??
  `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST ?? '127.0.0.1'}:${process.env.POSTGRES_PORT ?? process.env.DATABASE_PORT ?? '5432'}/${process.env.POSTGRES_DB}`;

const pool = new Pool({ connectionString: pgUrl, ssl: false });
const db = drizzle(pool);

import { account, member, user as userTable } from '../db/postgres/schema/auth.js';
import {
  KeycloakAdminClient,
  type KeycloakAdminConfig,
} from '../src/services/auth/keycloak_admin.js';
import type { SignalsUserRow } from '../src/services/auth/user_to_keycloak.js';
import {
  runMigration,
  runReconcile,
  runProbe,
  runPasswordAudit,
  type MigrationData,
  type MigrationOptions,
} from '../src/services/auth/migrate_core.js';

// ── args ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const value = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const MODE = has('--probe')
  ? 'probe'
  : has('--audit-passwords')
    ? 'audit-passwords'
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

// ── config ─────────────────────────────────────────────────────────────────

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

// ── data access (the SQL the core depends on) ────────────────────────────────

const data: MigrationData = {
  /**
   * Every human. **Service users are excluded** — each integrating DPG's machine
   * identity becomes a Keycloak *client* (§5, §6.4), not a user; a shell for one
   * would collide with the client-credentials service account. Recognised by
   * their `member.role='service'` row.
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

  async fetchPasswordAccountRows(): Promise<Array<{ providerId: string; n: number }>> {
    return db
      .select({ providerId: account.providerId, n: sql<number>`count(*)::int` })
      .from(account)
      .where(and(isNotNull(account.password), sql`${account.password} <> ''`))
      .groupBy(account.providerId);
  },
};

// ── main ───────────────────────────────────────────────────────────────────

const main = async (): Promise<number> => {
  if (MODE === 'audit-passwords') return (await runPasswordAudit(data)).code;

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
