/**
 * Idempotent seed for the two integrating-DPG service users:
 *   - aggregator-dpg
 *   - voice-dpg
 *
 * Each lives inside an organization with type='network_service' and owns
 * one apikey. Run after `pnpm db:push:api` so the better-auth tables exist.
 *
 * Run from repo root:  pnpm db:seed:services:api
 * Run inside apps/api: pnpm db:seed:services
 *
 * Idempotent — safe to re-run. Existing rows are reused; existing apikeys
 * are left alone. Minted keys are printed ONCE — capture them then and
 * store them in a secret manager.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '../../.env' });

// Build our own pg pool + drizzle instance rather than importing
// `apps/api/db/postgres/drizzle_config`, which transitively pulls in
// the API's full Zod env validation (INSTANCE_NAME, INSTANCE_ENV, etc.).
// A standalone DB-only script shouldn't require app-context env vars —
// matches the pattern db_init.ts uses for the same reason.
const pgUrl =
  process.env.POSTGRES_URL ??
  `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST ?? '127.0.0.1'}:${process.env.POSTGRES_PORT ?? process.env.DATABASE_PORT ?? '5432'}/${process.env.POSTGRES_DB}`;

const pool = new Pool({ connectionString: pgUrl, ssl: false });
const db = drizzle(pool);

import {
  user as userTable,
  organization,
  member,
  apikey,
} from '../db/postgres/schema/auth.js';

const SERVICES = [
  { slug: 'aggregator-dpg', user_email: 'aggregator-dpg-svc@signals.local' },
  { slug: 'voice-dpg', user_email: 'voice-dpg-svc@signals.local' },
] as const;

const ensure_org = async (slug: string, name: string): Promise<string> => {
  const [existing] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);
  if (existing) return existing.id;
  const id = `org_${randomUUID()}`;
  await db.insert(organization).values({
    id,
    slug,
    name,
    type: 'network_service',
    createdAt: new Date(),
  });
  console.log(`  org created: ${slug} (${id})`);
  return id;
};

const ensure_user = async (email: string, name: string): Promise<string> => {
  const [existing] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1);
  if (existing) return existing.id;
  const id = `usr_${randomUUID()}`;
  const now = new Date();
  await db.insert(userTable).values({
    id,
    email,
    name,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  console.log(`  user created: ${email} (${id})`);
  return id;
};

const ensure_member = async (user_id: string, org_id: string): Promise<void> => {
  const [existing] = await db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.userId, user_id))
    .limit(1);
  if (existing) return;
  await db.insert(member).values({
    id: `mem_${randomUUID()}`,
    organizationId: org_id,
    userId: user_id,
    role: 'service',
    createdAt: new Date(),
  });
  console.log(`  member linked: user=${user_id} org=${org_id} role=service`);
};

const ensure_apikey = async (user_id: string, name: string): Promise<void> => {
  const [existing] = await db
    .select({ id: apikey.id })
    .from(apikey)
    .where(eq(apikey.userId, user_id))
    .limit(1);
  if (existing) {
    console.log(
      `  apikey already exists for ${name} (id=${existing.id}); skipping mint.`
    );
    return;
  }
  const raw_key = `sk_signals_${randomBytes(24).toString('hex')}`;
  const now = new Date();
  await db.insert(apikey).values({
    id: `key_${randomUUID()}`,
    name,
    key: raw_key,
    userId: user_id,
    referenceId: user_id,
    configId: 'default',
    start: raw_key.slice(0, 6),
    prefix: 'sk_signals_',
    enabled: true,
    rateLimitEnabled: false,
    createdAt: now,
    updatedAt: now,
  });
  console.log(
    `MINTED ${name} apikey — store securely, will NOT be shown again:`
  );
  console.log(`  ${raw_key}`);
};

const main = async () => {
  for (const svc of SERVICES) {
    console.log(`\n${svc.slug}:`);
    const org_id = await ensure_org(
      svc.slug,
      `${svc.slug} (network service)`
    );
    const user_id = await ensure_user(svc.user_email, svc.slug);
    await ensure_member(user_id, org_id);
    await ensure_apikey(user_id, svc.slug);
  }
  console.log('\nseed complete.');
  process.exit(0);
};

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
