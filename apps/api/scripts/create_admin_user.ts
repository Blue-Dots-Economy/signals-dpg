/**
 * Create (or promote) a signals admin, in both signals and Keycloak.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Under better-auth, the first admin bootstrapped itself: `unified_otp`'s verify
 * minted `role: 'admin'` for any email on an `ADMIN_DOMAINS` domain, and
 * `assertSelfSignupAllowed` let that email through even on a **gated** instance
 * (`packages/auth/plugins/auth_guards.ts`). Neither has a Keycloak equivalent —
 * `provisioning.ts` and `self_signup.ts` both hardcode `role: 'user'`, and
 * `refreshMirror` deliberately never syncs role. So on a gated instance (the
 * default) there was no code path at all that could create the first admin.
 *
 * That is gap G2 of
 * `docs/superpowers/plans/2026-07-31-replace-better-auth-with-keycloak.md`.
 * The decision recorded there is to make admin creation an explicit **operator
 * action** rather than re-implement "this email domain implies admin", which was
 * weak authorisation dressed up as configuration.
 *
 * ── What it does ──────────────────────────────────────────────────────────
 * 1. Creates or reuses the local `user` row, with `role='admin'`.
 * 2. Creates the Keycloak identity with **the same id**, carrying the
 *    `signals_admin` realm role (`user_to_keycloak.ts` derives it from the row's
 *    role, so this follows automatically).
 *
 * The invariant that matters, as everywhere else in this migration:
 *
 *     keycloak user.id == sub == signals user.id
 *
 * so the id must be a **bare UUID**. Note this differs from
 * `seed_service_users.ts`, which prefixes ids (`usr_…`) — those are service
 * accounts that never log in through Keycloak, so the invariant does not bind
 * them. An admin does log in, so a prefixed id would break their session.
 *
 * ── Run ───────────────────────────────────────────────────────────────────
 *   cd apps/api
 *   pnpm tsx scripts/create_admin_user.ts --email=ops@example.org --name="Ops"
 *   pnpm tsx scripts/create_admin_user.ts --email=ops@example.org --name="Ops" --apply
 *   pnpm tsx scripts/create_admin_user.ts --phone=+919876543210 --name="Ops" --apply
 *
 * Dry run by default — it reports what it would do and writes nothing.
 *
 * Idempotent: an existing local user is **promoted** in place (never duplicated,
 * never re-keyed — their id is load-bearing for `items.created_by`), and an
 * existing Keycloak identity under the same id is left alone.
 *
 * ── Options ───────────────────────────────────────────────────────────────
 *   --email=<addr>       Admin's email. Either this or --phone is required.
 *   --phone=<e164>       Admin's phone in E.164. Drives the phone OTP channel.
 *   --name=<name>        Display name. Required when creating.
 *   --apply              Actually write. Without it, nothing is written.
 *   --env-path=<path>    Read this .env instead of searching.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import dotenv from 'dotenv';

/**
 * Env resolution, priority order: the real process environment always wins,
 * then `--env-path`, then the repo's known .env locations. Paths resolve from
 * this SCRIPT's location, not `process.cwd()`, so the behaviour does not depend
 * on where it is invoked from — the same reasoning as
 * `migrate_users_to_keycloak.ts`, which fixed exactly that bug.
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

// Own pool + drizzle rather than importing the API's `drizzle_config`, which
// transitively runs the full Zod env validation. A standalone script should not
// require app-context env vars — same reasoning as `seed_service_users.ts`.
const pgUrl =
  process.env.POSTGRES_URL ??
  `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST ?? '127.0.0.1'}:${process.env.POSTGRES_PORT ?? process.env.DATABASE_PORT ?? '5432'}/${process.env.POSTGRES_DB}`;

const pool = new Pool({ connectionString: pgUrl, ssl: false });
const db = drizzle(pool);

import { user as userTable } from '../db/postgres/schema/auth.js';
import {
  KeycloakAdminClient,
  type KeycloakAdminConfig,
} from '../src/services/auth/keycloak_admin.js';
import {
  mapUserToKeycloak,
  SIGNALS_ADMIN_ROLE,
} from '../src/services/auth/user_to_keycloak.js';

// ── args ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const value = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const APPLY = has('--apply');
const email = value('email')?.trim().toLowerCase() || null;
const phoneNumber = value('phone')?.trim() || null;
const name = value('name')?.trim() || null;

if (!email && !phoneNumber) {
  console.error('error: one of --email or --phone is required');
  process.exit(2);
}

// ── keycloak config ────────────────────────────────────────────────────────

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
    console.error(
      'An admin with no Keycloak identity could never sign in, so this script ' +
        'refuses to create a half-provisioned account.'
    );
    process.exit(2);
  }
  return { baseUrl, realm, clientId, clientSecret };
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const kcConfig = loadKeycloakConfig();
  console.log(`keycloak: ${kcConfig.baseUrl} realm=${kcConfig.realm}`);
  console.log(APPLY ? 'mode: APPLY (writing)' : 'mode: dry run (writing nothing)');

  const client = new KeycloakAdminClient(kcConfig);

  /**
   * Preflight: prove Keycloak is reachable and the credentials work BEFORE
   * touching the database.
   *
   * Without this, an unreachable Keycloak leaves a committed local row with
   * `role='admin'` and no realm identity — a privileged user who can never sign
   * in. Found the hard way: the first run of this script did exactly that when
   * pointed at the wrong port.
   */
  if (APPLY) {
    try {
      await client.accessToken();
      console.log('keycloak: reachable, credentials accepted');
    } catch (err) {
      console.error(
        'error: could not authenticate against Keycloak, so nothing was written.\n' +
          'Fix the connection/credentials and re-run — an admin with no realm ' +
          'identity could never sign in.'
      );
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }

  // Find any existing row by either identifier. Promoting in place matters: the
  // id is referenced by items.created_by and every *_owner column, so a second
  // row for the same person would orphan their data.
  const filters = [
    email ? eq(userTable.email, email) : undefined,
    phoneNumber ? eq(userTable.phoneNumber, phoneNumber) : undefined,
  ].filter((f): f is NonNullable<typeof f> => f !== undefined);

  const [existing] = await db
    .select({
      id: userTable.id,
      name: userTable.name,
      email: userTable.email,
      phoneNumber: userTable.phoneNumber,
      role: userTable.role,
    })
    .from(userTable)
    .where(filters.length === 1 ? filters[0] : or(...filters))
    .limit(1);

  let userId: string;
  let userName: string;
  /** How to undo the local write if the Keycloak step then fails. */
  let rollback: (() => Promise<void>) | null = null;

  if (existing) {
    userId = existing.id;
    userName = existing.name;
    if (existing.role === 'admin') {
      console.log(`local user: ${userId} is already an admin — nothing to change`);
    } else {
      console.log(`local user: promoting ${userId} from role='${existing.role}' to 'admin'`);
      if (APPLY) {
        const previousRole = existing.role;
        await db
          .update(userTable)
          .set({ role: 'admin', updatedAt: new Date() })
          .where(eq(userTable.id, userId));
        // Revert the role, never delete — this row predates the script and its
        // id is referenced by their items.
        rollback = async () => {
          await db
            .update(userTable)
            .set({ role: previousRole, updatedAt: new Date() })
            .where(eq(userTable.id, userId));
          console.log(`rolled back: ${userId} restored to role='${previousRole}'`);
        };
      }
    }
  } else {
    if (!name) {
      console.error('error: --name is required when creating a new admin');
      process.exit(2);
    }
    // Bare UUID — this becomes the Keycloak `sub`. See the header note.
    userId = randomUUID();
    userName = name;
    console.log(`local user: creating ${userId} with role='admin'`);
    if (APPLY) {
      const now = new Date();
      await db.insert(userTable).values({
        id: userId,
        name,
        email,
        // The OTP login is what verifies an identifier; an operator creating the
        // row proves nothing about it. Same stance as self_signup.ts.
        emailVerified: false,
        phoneNumber,
        phoneNumberVerified: false,
        image: '',
        role: 'admin',
        banned: false,
        banReason: '',
        banExpires: null,
        // Matches the row `unified_otp`'s admin path produced, which this
        // replaces. An operator-created admin sees no consent screens.
        termsAccepted: true,
        privacyAccepted: true,
        createdAt: now,
        updatedAt: now,
      });
      // We created it, so undoing means removing it — nothing references it yet.
      rollback = async () => {
        await db.delete(userTable).where(eq(userTable.id, userId));
        console.log(`rolled back: removed the orphan local row ${userId}`);
      };
    }
  }

  // ── the Keycloak identity ────────────────────────────────────────────────
  const mapped = mapUserToKeycloak({
    id: userId,
    name: userName,
    email: existing?.email ?? email,
    emailVerified: false,
    phoneNumber: existing?.phoneNumber ?? phoneNumber,
    phoneNumberVerified: false,
    role: 'admin',
    banned: false,
    banReason: null,
    banExpires: null,
  });

  if (!mapped.ok) {
    console.error(`error: could not map the user for Keycloak — ${mapped.message}`);
    process.exit(1);
  }

  console.log(
    `keycloak identity: username=${mapped.user.username} realmRoles=${JSON.stringify(mapped.user.realmRoles)}`
  );
  if (!mapped.user.realmRoles.includes(SIGNALS_ADMIN_ROLE)) {
    // Guard rather than assume: the realm role is what a future
    // realm-role -> user.role sync will read, so a silently missing one would
    // make this admin look like a participant to that mapping.
    console.error(
      `error: expected the ${SIGNALS_ADMIN_ROLE} realm role to be mapped; got ` +
        JSON.stringify(mapped.user.realmRoles)
    );
    process.exit(1);
  }

  if (!APPLY) {
    console.log('dry run complete — re-run with --apply to write.');
    return;
  }

  /** Undo the local write, then exit non-zero. Leaves no half-provisioned admin. */
  async function failAfterLocalWrite(message: string): Promise<never> {
    console.error(`error: ${message}`);
    if (rollback) {
      try {
        await rollback();
      } catch (rollbackErr) {
        console.error(
          'CRITICAL: could not roll back the local write. Clean up manually — ' +
            `user id ${userId}.`
        );
        console.error(rollbackErr);
      }
    }
    await pool.end();
    process.exit(1);
  }

  let outcome;
  try {
    outcome = await client.createUserPreservingId(mapped.user);
  } catch (err) {
    return failAfterLocalWrite(
      `could not reach Keycloak to create the identity — ${err instanceof Error ? err.message : String(err)}`
    );
  }

  switch (outcome.kind) {
    case 'created':
      console.log(`keycloak: created ${userId}`);
      break;
    case 'already_exists':
      console.log(`keycloak: ${userId} already exists — left alone`);
      break;
    case 'created_with_different_id':
      return failAfterLocalWrite(
        `Keycloak assigned id ${outcome.assignedId} instead of ${userId}. ` +
          'The sub == user.id invariant is broken; this admin could not sign in.'
      );
    case 'conflict':
      return failAfterLocalWrite(`Keycloak rejected the import — ${outcome.detail}`);
  }

  // Report the realm role as Keycloak actually stored it, rather than trusting
  // that partialImport honoured the representation we sent.
  const roles = await client.realmRolesFor(userId);
  console.log(`keycloak: realm roles now ${JSON.stringify(roles)}`);
  if (!roles.includes(SIGNALS_ADMIN_ROLE)) {
    console.error(
      `warning: ${SIGNALS_ADMIN_ROLE} is NOT assigned in Keycloak. The local row ` +
        'is an admin, so signals authorises them today, but any future ' +
        'realm-role -> user.role sync would not see it. Assign it manually.'
    );
  }

  console.log(`\ndone. admin user id: ${userId}`);
  console.log('They sign in through the normal OTP login — no password is set.');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
