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
 * ── Environment ────────────────────────────────────────────────────────────
 * The process environment always wins. With no `--env-path`, the repo's `.env`
 * and then `local-setup/.env` are tried, resolved from this script's location so
 * the cwd does not matter. In dev/staging/prod there is no file at all and the
 * injected env vars are used directly — so the same invocation works everywhere:
 *
 *   local (Docker stack)  pnpm tsx scripts/migrate_users_to_keycloak.ts --probe
 *   local (explicit)      … --env-path=../../local-setup/.env --probe
 *   dev / staging / prod  … --probe          # env comes from the platform
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
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import dotenv from 'dotenv';

/**
 * Environment resolution, in priority order:
 *
 *   1. the real process environment — ALWAYS wins
 *   2. `--env-path=<path>`, if given
 *   3. the first of the repo's known .env locations that exists
 *
 * Point 1 is what makes this usable in dev/staging/prod: there is no .env file
 * in a container, the values arrive as injected env vars, and a dotenv file must
 * never clobber them. `override: false` is the default but is stated explicitly
 * because getting it wrong would silently prefer a stale local file over the
 * deployment's own secrets.
 *
 * Paths resolve from the SCRIPT's location, not `process.cwd()`, so the script
 * behaves the same whether it is run from `apps/api` or the repo root. The
 * previous hardcoded `../../.env` silently read nothing when the cwd differed —
 * and, worse, never looked at `local-setup/.env` where the Docker stack's values
 * actually live.
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
  // No file is entirely normal in a deployed environment.
  console.log('env: no .env file found — using the process environment only');
}

loadEnvFile();

// Own pg pool + drizzle handle rather than importing
// `apps/api/db/postgres/drizzle_config`, which transitively runs the API's full
// Zod env validation. A standalone script should not require app-context env
// vars — same reasoning as scripts/seed_service_users.ts and db_init.ts.
const pgUrl =
  process.env.POSTGRES_URL ??
  `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST ?? '127.0.0.1'}:${process.env.POSTGRES_PORT ?? process.env.DATABASE_PORT ?? '5432'}/${process.env.POSTGRES_DB}`;

const pool = new Pool({ connectionString: pgUrl, ssl: false });
const db = drizzle(pool);

import {
  account,
  member,
  organization,
  user as userTable,
} from '../db/postgres/schema/auth.js';
import {
  KeycloakAdminClient,
  KeycloakAdminError,
  type KeycloakAdminConfig,
} from '../src/services/auth/keycloak_admin.js';
import {
  mapUserToKeycloak,
  type KeycloakUserRepresentation,
  type SignalsUserRow,
} from '../src/services/auth/user_to_keycloak.js';

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

const STRATEGY = value('strategy') === 'import' ? 'import' : 'create';
const BATCH = Number(value('batch') ?? 100);
const LIMIT = value('limit') ? Number(value('limit')) : undefined;

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

// ── queries ────────────────────────────────────────────────────────────────

/**
 * The users to migrate: every human.
 *
 * **Service users are excluded.** Each integrating DPG's machine identity
 * becomes a Keycloak *client* (§5, §6.4), not a Keycloak user — creating user
 * shells for them would be wrong and would collide with the client-credentials
 * service accounts. They are recognised by their `member.role='service'` row.
 */
async function fetchHumanUsers(limit?: number): Promise<SignalsUserRow[]> {
  const serviceUserIds = db
    .select({ userId: member.userId })
    .from(member)
    .where(eq(member.role, 'service'));

  const rows = await db
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

  return rows;
}

async function countServiceUsers(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(member)
    .where(eq(member.role, 'service'));
  return rows[0]?.n ?? 0;
}

// ── modes ──────────────────────────────────────────────────────────────────

/**
 * §6.3 spike 1, executed rather than assumed.
 *
 * Creates a throwaway user with a known UUID and reports whether Keycloak kept
 * it. This is the single most important pre-migration check: if the id is not
 * honoured, the whole non-destructive strategy needs `--strategy=import`, and
 * if neither works the design's plan B (open question 7) is required.
 */
async function runProbe(client: KeycloakAdminClient): Promise<number> {
  const probeId = randomUUID();
  const probeUser = {
    id: probeId,
    username: `zz-uuid-probe-${probeId}`,
    enabled: false,
    emailVerified: false,
    attributes: {},
    realmRoles: [],
    credentials: [] as never[],
    requiredActions: [] as never[],
  };

  console.log(`probing whether POST /users honours a supplied id (${probeId})…`);

  let outcome;
  try {
    outcome = await client.createUser(probeUser);
  } catch (err) {
    console.error('probe failed to create a user:', describe(err));
    return 1;
  }

  let verdict: 'honoured' | 'ignored' | 'inconclusive' = 'inconclusive';
  if (outcome.kind === 'created') {
    const readBack = await client.getUserById(probeId).catch(() => null);
    verdict = readBack ? 'honoured' : 'ignored';
  } else if (outcome.kind === 'created_with_different_id') {
    verdict = 'ignored';
    console.log(`  Keycloak assigned its own id: ${outcome.assignedId}`);
  }

  // Clean up both possible ids so the probe leaves nothing behind.
  await client.deleteUser(probeId).catch(() => {});
  if (outcome.kind === 'created_with_different_id') {
    await client.deleteUser(outcome.assignedId).catch(() => {});
  }

  console.log('');
  if (verdict === 'honoured') {
    console.log('RESULT: this Keycloak HONOURS a client-supplied id.');
    console.log('  -> run the migration with the default --strategy=create.');
    return 0;
  }
  if (verdict === 'ignored') {
    console.log('RESULT: this Keycloak IGNORES a client-supplied id.');
    console.log('  -> POST /users cannot preserve UUIDs. Re-run the probe logic');
    console.log('     via --strategy=import, which uses partialImport, and');
    console.log('     verify with --reconcile before trusting it.');
    return 1;
  }
  console.log(`RESULT: inconclusive (create returned "${outcome.kind}").`);
  return 1;
}

/**
 * Risk R6: the "no credentials to migrate" assumption only holds if nobody
 * actually has a password. `emailAndPassword.enabled` is true in the
 * better-auth config, so a password account *could* exist.
 */
async function runPasswordAudit(): Promise<number> {
  const rows = await db
    .select({
      providerId: account.providerId,
      n: sql<number>`count(*)::int`,
    })
    .from(account)
    .where(and(isNotNull(account.password), sql`${account.password} <> ''`))
    .groupBy(account.providerId);

  const total = rows.reduce((sum, r) => sum + r.n, 0);

  console.log(`password-bearing rows in \`account\`: ${total}`);
  for (const row of rows) {
    console.log(`  provider=${row.providerId}: ${row.n}`);
  }
  console.log('');

  if (total === 0) {
    console.log('RESULT: no password accounts. The OTP-only migration holds (R6 clear).');
    return 0;
  }

  console.log('RESULT: password accounts EXIST.');
  console.log('  These users have no OTP-only path and will not be able to sign in');
  console.log('  after cutover. Plan a reset flow before R4 — do not proceed on the');
  console.log('  assumption that there are no credentials to migrate.');
  console.log('  (Note: admin-onboarded participants get a random throwaway password');
  console.log('   via signUpEmail, so some rows here may be benign — check whether any');
  console.log('   user actually authenticates with one before planning the reset.)');
  return 1;
}

interface Tally {
  total: number;
  created: number;
  skipped: number;
  conflicts: number;
  unmappable: number;
  idNotHonoured: number;
  failed: number;
}

function emptyTally(total: number): Tally {
  return {
    total,
    created: 0,
    skipped: 0,
    conflicts: 0,
    unmappable: 0,
    idNotHonoured: 0,
    failed: 0,
  };
}

/**
 * Refuse to run if `phoneNumber` writes would be silently discarded.
 *
 * Keycloak 26 ignores `kc.user.profile.config` on realm import, and an
 * undeclared attribute is dropped on write without an error. The failure is
 * invisible: the migration reports success, `--reconcile` passes (ids are all
 * there), and yet every phone-only user has no phone attribute — so the OTP
 * authenticator has nowhere to send a code and they cannot log in.
 *
 * Checking up front is much cheaper than discovering it after a full run.
 */
async function assertAttributesPersist(client: KeycloakAdminClient): Promise<boolean> {
  const ok = await client.attributesWillPersist('phoneNumber');
  if (ok) return true;

  console.error('');
  console.error('ABORT: this realm will silently DROP the `phoneNumber` attribute.');
  console.error('  `phoneNumber` is neither declared in the realm user profile nor');
  console.error('  covered by an unmanaged-attribute policy. Keycloak accepts such');
  console.error('  writes and discards them, so migrated phone users would end up');
  console.error('  unable to receive an OTP — with nothing in the logs to say why.');
  console.error('');
  console.error('  Fix: run infra/keycloak/init/apply-user-profile.sh against this');
  console.error('  realm, then re-run. (Keycloak 26 ignores kc.user.profile.config');
  console.error('  from a realm import, which is why the realm JSON is not enough.)');
  return false;
}

async function runMigration(
  client: KeycloakAdminClient,
  apply: boolean
): Promise<number> {
  if (!(await assertAttributesPersist(client))) return 2;

  const users = await fetchHumanUsers(LIMIT);
  const excluded = await countServiceUsers();
  const tally = emptyTally(users.length);

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — strategy=${STRATEGY}`);
  console.log(`local human users to migrate: ${users.length}`);
  console.log(`service users excluded (they become Keycloak clients): ${excluded}`);
  if (LIMIT !== undefined) {
    // Never let a bounded run read as full coverage.
    console.log(`NOTE: --limit=${LIMIT} — this is a partial run, not full coverage.`);
  }
  console.log('');

  const ready: Array<{ row: SignalsUserRow; user: KeycloakUserRepresentation }> = [];

  for (const row of users) {
    const rep = mapUserToKeycloak(row);
    if (rep.ok) {
      ready.push({ row, user: rep.user });
    } else {
      tally.unmappable += 1;
      console.log(`  SKIP  ${row.id}  unmappable: ${rep.message}`);
    }
  }

  if (!apply) {
    // Dry run: report the collision case (§6.3 spike 2) without writing.
    for (const { row } of ready) {
      try {
        const existing = await client.getUserById(row.id);
        if (existing) {
          tally.skipped += 1;
          continue;
        }
        const clash = row.email
          ? await client.findByEmail(row.email)
          : row.phoneNumber
            ? await client.findByPhone(row.phoneNumber)
            : [];
        const foreign = clash.filter((c) => c.id !== row.id);
        if (foreign.length > 0) {
          tally.conflicts += 1;
          console.log(
            `  CONFLICT ${row.id}  identifiers already held by Keycloak user ${foreign[0].id}`
          );
          continue;
        }
        tally.created += 1;
      } catch (err) {
        tally.failed += 1;
        console.log(`  ERROR ${row.id}  ${describe(err)}`);
      }
    }
    report(tally, apply);
    return tally.conflicts > 0 || tally.failed > 0 ? 1 : 0;
  }

  if (STRATEGY === 'import') {
    for (let i = 0; i < ready.length; i += BATCH) {
      const batch = ready.slice(i, i + BATCH).map((r) => r.user);
      try {
        const result = await client.partialImportUsers(batch);
        tally.created += result.added;
        tally.skipped += result.skipped;
        console.log(
          `  batch ${i / BATCH + 1}: added=${result.added} skipped=${result.skipped}`
        );
      } catch (err) {
        tally.failed += batch.length;
        console.log(`  ERROR batch ${i / BATCH + 1}: ${describe(err)}`);
      }
    }
    report(tally, apply);
    return tally.failed > 0 ? 1 : 0;
  }

  for (const { user } of ready) {
    try {
      const outcome = await client.createUser(user);
      switch (outcome.kind) {
        case 'created':
          tally.created += 1;
          break;
        case 'already_exists':
          tally.skipped += 1;
          break;
        case 'conflict':
          tally.conflicts += 1;
          console.log(`  CONFLICT ${user.id}  ${outcome.detail}`);
          break;
        case 'created_with_different_id':
          // Stop immediately: continuing would produce a population whose subs
          // do not match the local ids, which is the one thing this migration
          // must never do.
          tally.idNotHonoured += 1;
          console.error('');
          console.error(
            `FATAL: Keycloak assigned id ${outcome.assignedId} instead of ${user.id}.`
          );
          console.error('  UUIDs are NOT being preserved. Aborting before more rows are');
          console.error('  written. Delete the users created so far, then re-run with');
          console.error('  --strategy=import. See §6.3 spike 1.');
          report(tally, apply);
          return 1;
      }
    } catch (err) {
      tally.failed += 1;
      console.log(`  ERROR ${user.id}  ${describe(err)}`);
    }
  }

  report(tally, apply);
  return tally.failed > 0 || tally.conflicts > 0 ? 1 : 0;
}

/**
 * The R4 go/no-go gate: "dry-run reconciles 1:1". Every local human user must
 * have a Keycloak user under the same id.
 */
async function runReconcile(client: KeycloakAdminClient): Promise<number> {
  const users = await fetchHumanUsers(LIMIT);
  const missing: string[] = [];
  /**
   * Users present by id but missing their phone attribute. Checked separately
   * because id-presence alone is a FALSE GREEN: partialImport happily creates
   * the user and drops the attribute when the realm user profile has not been
   * configured, and such a user can never receive an OTP.
   */
  const missingPhoneAttr: string[] = [];
  let matched = 0;
  let errored = 0;

  for (const row of users) {
    try {
      const found = await client.getUserById(row.id);
      if (!found) {
        missing.push(row.id);
        continue;
      }
      matched += 1;
      if (row.phoneNumber?.trim() && !found.attributes?.phoneNumber?.length) {
        missingPhoneAttr.push(row.id);
      }
    } catch (err) {
      errored += 1;
      console.log(`  ERROR ${row.id}  ${describe(err)}`);
    }
  }

  console.log('');
  console.log(`local human users: ${users.length}`);
  console.log(`matched in Keycloak by id: ${matched}`);
  console.log(`missing: ${missing.length}`);
  console.log(`present but missing the phoneNumber attribute: ${missingPhoneAttr.length}`);
  console.log(`errored: ${errored}`);

  for (const id of missing.slice(0, 50)) console.log(`  MISSING ${id}`);
  if (missing.length > 50) console.log(`  … and ${missing.length - 50} more`);

  for (const id of missingPhoneAttr.slice(0, 50)) console.log(`  NO_PHONE_ATTR ${id}`);
  if (missingPhoneAttr.length > 50) {
    console.log(`  … and ${missingPhoneAttr.length - 50} more`);
  }

  console.log('');
  if (missing.length === 0 && missingPhoneAttr.length === 0 && errored === 0) {
    console.log('RESULT: reconciles 1:1, phone attributes intact. R4 gate is green.');
    return 0;
  }
  if (missingPhoneAttr.length > 0) {
    console.log('RESULT: ids reconcile but phone attributes were DROPPED.');
    console.log('  These users cannot receive an OTP. Run');
    console.log('  infra/keycloak/init/apply-user-profile.sh, then re-run the');
    console.log('  migration — partialImport with ifResourceExists=SKIP will not');
    console.log('  repair an existing user, so those rows need deleting first.');
    return 1;
  }
  console.log('RESULT: does NOT reconcile. Do not advance past R4.');
  return 1;
}

function report(tally: Tally, apply: boolean): void {
  console.log('');
  console.log(`${apply ? 'applied' : 'would apply'}:`);
  console.log(`  total considered: ${tally.total}`);
  console.log(`  ${apply ? 'created' : 'to create'}: ${tally.created}`);
  console.log(`  already present (skipped): ${tally.skipped}`);
  console.log(`  identifier conflicts: ${tally.conflicts}`);
  console.log(`  unmappable rows: ${tally.unmappable}`);
  console.log(`  id-not-honoured: ${tally.idNotHonoured}`);
  console.log(`  errors: ${tally.failed}`);
}

function describe(err: unknown): string {
  if (err instanceof KeycloakAdminError) {
    return `${err.message}${err.status ? ` (HTTP ${err.status})` : ''}${err.body ? `: ${err.body}` : ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ── main ───────────────────────────────────────────────────────────────────

const main = async (): Promise<number> => {
  if (MODE === 'audit-passwords') return runPasswordAudit();

  const client = new KeycloakAdminClient(loadKeycloakConfig());

  switch (MODE) {
    case 'probe':
      return runProbe(client);
    case 'reconcile':
      return runReconcile(client);
    case 'apply':
      return runMigration(client, true);
    default:
      return runMigration(client, false);
  }
};

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('migration failed:', describe(err));
    await pool.end();
    process.exit(1);
  });
