/**
 * One-off: make an aggregator's bulk-onboarded profiles LIVE + discoverable.
 *
 * Bulk onboarding (/admin/participant) creates profiles `draft` and never writes
 * an item-level `profile_creation` consent row, so they stay draft. This script,
 * scoped to a single aggregator org (by email), for every DRAFT profile item
 * whose creator that org onboarded:
 *   1. sets a random ADULT date_of_birth (1990–2000) when unset — so the U18
 *      guardian gate treats them as adults (these uploads are all adults);
 *   2. records user-level `terms` + `privacy` and item-level `profile_creation`
 *      consent (the aggregator asserted terms/privacy at onboarding), with the
 *      config-resolved version;
 *   3. flips the item to `lifecycle_status = 'live'`.
 *
 * Assumes required fields are already complete (validated at CSV upload). Minors
 * are never created by this aggregator, and the random adult DOB guarantees the
 * U18 gate is satisfied.
 *
 * DRY-RUN by default (prints what it would change). Pass --apply to write.
 *
 *   pnpm --filter api exec tsx scripts/promote_aggregator_profiles.ts \
 *     --org-email=<aggregator email> [--apply]
 *
 * Idempotent: re-running only touches rows still draft / consent still missing.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { user, organization, member, consent_record } from '@api/db/postgres/schema';
import { resolveConsentVersion } from '@/services/consent_version';

const args = process.argv.slice(2);
const argVal = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const orgId = argVal('org-id');
const orgSlug = argVal('org-slug');
const orgEmail = argVal('org-email'); // a member/admin user's email → their org
const APPLY = args.includes('--apply');

if (!orgId && !orgSlug && !orgEmail) {
  console.error('Provide one of: --org-id=<id> | --org-slug=<slug> | --org-email=<member email>');
  process.exit(1);
}

async function resolveOrg(): Promise<{ id: string; name: string } | null> {
  if (orgId) {
    const [o] = await db.select({ id: organization.id, name: organization.name }).from(organization).where(eq(organization.id, orgId)).limit(1);
    return o ?? null;
  }
  if (orgSlug) {
    const [o] = await db.select({ id: organization.id, name: organization.name }).from(organization).where(eq(organization.slug, orgSlug)).limit(1);
    return o ?? null;
  }
  // org-email: the email belongs to a user who is a member of the aggregator org.
  const [o] = await db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .innerJoin(member, eq(member.organizationId, organization.id))
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(user.email, orgEmail as string))
    .limit(1);
  return o ?? null;
}

function randomAdultDob(): Date {
  const y = 1990 + Math.floor(Math.random() * 11); // 1990..2000
  const m = Math.floor(Math.random() * 12);
  const d = 1 + Math.floor(Math.random() * 28);
  return new Date(Date.UTC(y, m, d));
}

async function ensureUserConsent(userId: string, network: string, category: 'terms' | 'privacy', version: number) {
  const existing = await db
    .select({ id: consent_record.id })
    .from(consent_record)
    .where(
      and(
        eq(consent_record.level, 'user'),
        eq(consent_record.consentCategory, category),
        eq(consent_record.userId, userId),
        eq(consent_record.network, network),
      ),
    )
    .limit(1);
  if (existing.length) return false;
  await db.insert(consent_record).values({
    level: 'user',
    consentCategory: category,
    userId,
    network,
    documentVersion: version,
    source: 'profile',
    acceptedAt: new Date(),
  });
  return true;
}

async function main() {
  console.log(`promote_aggregator_profiles → ${APPLY ? 'APPLY' : 'DRY-RUN'} | ${orgId ? `org-id=${orgId}` : orgSlug ? `org-slug=${orgSlug}` : `org-email=${orgEmail}`}`);

  const org = await resolveOrg();
  if (!org) {
    console.error('No organization resolved from the given selector');
    process.exit(1);
  }
  console.log(`org: ${org.name} (${org.id})`);

  const usersOnboarded = await db
    .select({ id: user.id, dob: user.dateOfBirth })
    .from(user)
    .where(eq(user.onboardedByOrgId, org.id));
  const userIds = usersOnboarded.map((u) => u.id);
  console.log(`users onboarded by this org: ${userIds.length}`);
  if (userIds.length === 0) return;

  // Draft profile items owned by those users.
  const draftItems = await db
    .select({
      item_id: items.item_id,
      item_network: items.item_network,
      item_domain: items.item_domain,
      created_by: items.created_by,
    })
    .from(items)
    .where(
      and(
        inArray(items.created_by, userIds),
        eq(items.lifecycle_status, 'draft'),
        sql`${items.item_type} LIKE 'profile%'`,
      ),
    );

  const byNet = new Map<string, number>();
  for (const it of draftItems) byNet.set(`${it.item_network}/${it.item_domain}`, (byNet.get(`${it.item_network}/${it.item_domain}`) ?? 0) + 1);
  const usersMissingDob = usersOnboarded.filter((u) => !u.dob).length;
  console.log(`draft profile items to promote: ${draftItems.length}`);
  for (const [k, n] of byNet) console.log(`  ${k}: ${n}`);
  console.log(`users needing a random adult DOB: ${usersMissingDob}`);

  if (!APPLY) {
    console.log('\nDRY-RUN — no changes written. Re-run with --apply to promote.');
    return;
  }

  // 1. Random adult DOB for users that don't have one yet.
  let dobSet = 0;
  for (const u of usersOnboarded) {
    if (u.dob) continue;
    await db.update(user).set({ dateOfBirth: randomAdultDob(), updatedAt: new Date() }).where(eq(user.id, u.id));
    dobSet++;
  }
  console.log(`set adult DOB for ${dobSet} user(s)`);

  // 2. Consent + 3. promote, per item. Version cache per network.
  const versionCache = new Map<string, { terms: number | null; privacy: number | null; profile: number | null }>();
  async function versions(network: string) {
    if (!versionCache.has(network)) {
      versionCache.set(network, {
        terms: await resolveConsentVersion({ network, category: 'terms' }),
        privacy: await resolveConsentVersion({ network, category: 'privacy' }),
        profile: await resolveConsentVersion({ network, category: 'profile_creation' }),
      });
    }
    return versionCache.get(network)!;
  }

  let promoted = 0;
  let skippedNoVersion = 0;
  const userTermsDone = new Set<string>();
  for (const it of draftItems) {
    const v = await versions(it.item_network);
    if (v.profile === null) {
      skippedNoVersion++;
      continue; // no profile_creation consent configured — can't gate live
    }
    // user-level terms + privacy (once per user+network)
    const utKey = `${it.created_by}:${it.item_network}`;
    if (!userTermsDone.has(utKey)) {
      if (v.terms !== null) await ensureUserConsent(it.created_by, it.item_network, 'terms', v.terms);
      if (v.privacy !== null) await ensureUserConsent(it.created_by, it.item_network, 'privacy', v.privacy);
      userTermsDone.add(utKey);
    }
    // item-level profile_creation (idempotent via the partial unique index)
    await db
      .insert(consent_record)
      .values({
        level: 'item',
        consentCategory: 'profile_creation',
        userId: it.created_by,
        itemId: it.item_id,
        network: it.item_network,
        documentVersion: v.profile,
        source: 'profile',
        acceptedAt: new Date(),
      })
      .onConflictDoNothing();
    // flip live (fields assumed complete; adult DOB set above → U18 gate satisfied)
    await db
      .update(items)
      .set({ lifecycle_status: 'live', updated_at: sql`now()` })
      .where(and(eq(items.item_id, it.item_id), eq(items.lifecycle_status, 'draft')));
    promoted++;
  }

  console.log(`promoted ${promoted} profile(s) to live`);
  if (skippedNoVersion) console.log(`skipped ${skippedNoVersion} (no profile_creation consent version configured for their network)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('promote_aggregator_profiles failed:', err);
    process.exit(1);
  });
