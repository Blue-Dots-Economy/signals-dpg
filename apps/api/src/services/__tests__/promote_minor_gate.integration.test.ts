/**
 * Phase 5a Task 1 — integration test for the U18 guardian-consent gate in
 * `promoteItemOnProfileConsent` (apps/api/src/services/item_service.ts).
 *
 * A minor's profile must NOT go live on the adult self-consent path when the
 * served domain is `guardian_consent_required` (network.json) — only a
 * GUARDIAN-sourced `profile_creation` consent row (keyed on the ward's own
 * user_id, `source: 'guardian'`) can promote it (spec §7 / D11/D13).
 * blue_dot's seeker + provider domains are both gated in
 * examples/schemas/blue_dot/network.json so this suite exercises the gate
 * regardless of which one is served locally.
 *
 * The item is seeded via `createItemInternal` (same helper `create_item`
 * uses) rather than a raw `db.insert`, because `promoteItemOnProfileConsent`
 * re-fetches the item's schema by its `item_schema_url` — in local dev config
 * that URL is this instance's own `/api/v1/network/schema/...` endpoint, so a
 * minimal Fastify app registering only `network_routes` is stood up here to
 * serve that self-fetch (the same pattern
 * `services/items/__tests__/lifecycle.integration.test.ts` relies on).
 *
 * Run:
 *   docker compose up -d db redis
 *   pnpm --filter api test:integration src/services/__tests__/promote_minor_gate.integration.test.ts
 *
 * Skip condition: if POSTGRES_URL/POSTGRES_USER is unset the suite is
 * describe.skip'd so CI without a live DB stays green.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@api/db/postgres/drizzle_config';
import { items, ensureItemPartition } from '@dpg/database';
import { minor_guardian, consent_record } from '@api/db/postgres/schema';
import { user as userTable } from '../../../db/postgres/schema/auth.js';
import { createItemInternal, promoteItemOnProfileConsent } from '@/services/item_service';
import { apiConfig } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import { resolveConsentVersion } from '@/services/consent_version';
import { guardianConsentRequired } from '@/services/minor';
import {
  generateMinimalItemState,
  resolveBindings,
} from '../../routes/v1/__tests__/integration_helpers';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const skip_reason = !pg_url
  ? 'POSTGRES_URL / POSTGRES_USER not set — skipping integration suite'
  : '';

const describeIf = can_run ? describe : describe.skip;

describeIf(
  `promoteItemOnProfileConsent U18 guardian gate (integration)${
    can_run ? '' : ` — ${skip_reason}`
  }`,
  () => {
    let app: FastifyInstance;
    const listen_port = Number(process.env.API_PORT ?? 2742);

    const minor_user_id = `usr_minor_${randomUUID()}`;

    let served_network: string;
    let served_domain: string;
    let served_item_type: string;
    let item_id: string | undefined;

    beforeAll(async () => {
      const network_routes_mod = await import('../../routes/v1/network/network_routes.js');

      app = Fastify().withTypeProvider<ZodTypeProvider>();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      await app.register(network_routes_mod.default, { prefix: '/api/v1/network' });

      try {
        await app.listen({ port: listen_port, host: '127.0.0.1' });
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e?.code === 'EADDRINUSE') {
          throw new Error(
            `promote_minor_gate integration test requires port ${listen_port} to be free ` +
              `(set API_PORT). Is the dev server already running?`,
          );
        }
        throw err;
      }
    });

    afterAll(async () => {
      try {
        await db.delete(consent_record).where(eq(consent_record.userId, minor_user_id));
        await db.delete(minor_guardian).where(eq(minor_guardian.userId, minor_user_id));
        if (served_network && served_domain && served_item_type && item_id) {
          await db
            .delete(items)
            .where(
              and(
                eq(items.item_network, served_network),
                eq(items.item_domain, served_domain),
                eq(items.item_type, served_item_type),
                eq(items.item_id, item_id),
              ),
            );
        }
        await db.delete(userTable).where(eq(userTable.id, minor_user_id));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('promote_minor_gate integration test cleanup failed:', err);
      }
      if (app) await app.close();
    });

    it('fails closed for a minor with no guardian consent, then promotes once guardian profile_creation consent is recorded', async () => {
      if (apiConfig.served_domains.length === 0) {
        throw new Error(
          'promote_minor_gate integration suite requires SERVED_DOMAINS to have at least one entry',
        );
      }

      const bindings = await resolveBindings();
      served_network = bindings.primary.network;
      served_domain = bindings.primary.domain;
      served_item_type = bindings.primary.item_type;

      const networkConfig = await getNetworkConfigById(served_network);

      // The gate only fires on a guardian_consent_required domain. blue_dot's
      // seeker + provider domains are both gated (Step 0 of this task); if the
      // served domain isn't one of those, document the skip loudly rather than
      // silently passing.
      if (!guardianConsentRequired(networkConfig, served_domain)) {
        // eslint-disable-next-line no-console
        console.warn(
          `promote_minor_gate: served domain "${served_domain}" on network "${served_network}" ` +
            'is not guardian_consent_required — the U18 gate cannot be exercised here. ' +
            'Run with SERVED_DOMAINS including a gated seeker/provider domain.',
        );
        expect(true).toBe(true);
        return;
      }

      await ensureItemPartition(db, served_network, served_domain);

      // items.created_by has an FK to the user table — seed the minor's user
      // row before inserting the item.
      const now = new Date();
      await db.insert(userTable).values({
        id: minor_user_id,
        name: 'promote-minor-gate-int-user',
        email: `promote-minor-gate-${randomUUID()}@signals.local`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });

      const item_state = generateMinimalItemState(bindings.primary.schema);
      const created = await createItemInternal(db, {
        item_network: served_network,
        item_domain: served_domain,
        item_type: served_item_type,
        item_state,
        created_by: minor_user_id,
      });
      item_id = created.itemId;

      // Sanity: a brand-new item is always draft (consent pending at create
      // time — aggregator-dpg#464), regardless of completeness.
      const [seeded] = await db
        .select({ lifecycle_status: items.lifecycle_status })
        .from(items)
        .where(eq(items.item_id, item_id));
      expect(seeded.lifecycle_status).toBe('draft');

      // Ward is a clear minor (born 2012).
      await db.insert(minor_guardian).values({
        userId: minor_user_id,
        birthYear: 2012,
        birthMonth: 1,
        guardianVerified: false,
      });

      // 1. Required fields are complete but no guardian profile_creation row
      //    exists yet → the gate fails closed and the item stays draft.
      const firstAttempt = await promoteItemOnProfileConsent(db, item_id);
      expect(firstAttempt).toBe(false);

      const [afterFirst] = await db
        .select({ lifecycle_status: items.lifecycle_status })
        .from(items)
        .where(eq(items.item_id, item_id));
      expect(afterFirst.lifecycle_status).toBe('draft');

      // 2. Guardian records profile_creation consent on the ward's behalf —
      //    the row is keyed on the ward's own user_id, source: 'guardian'.
      const version = await resolveConsentVersion({
        network: served_network,
        category: 'profile_creation',
        variant: 'u18',
      });
      expect(version).not.toBeNull();

      await db.insert(consent_record).values({
        level: 'item',
        consentCategory: 'profile_creation',
        userId: minor_user_id,
        itemId: item_id,
        network: served_network,
        documentVersion: version as number,
        source: 'guardian',
        acceptedAt: new Date(),
      });

      // 3. Now the guardian consent satisfies the gate → promotes to live.
      const secondAttempt = await promoteItemOnProfileConsent(db, item_id);
      expect(secondAttempt).toBe(true);

      const [afterSecond] = await db
        .select({ lifecycle_status: items.lifecycle_status })
        .from(items)
        .where(eq(items.item_id, item_id));
      expect(afterSecond.lifecycle_status).toBe('live');
    });
  },
);
