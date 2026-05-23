/**
 * Plan B Task 12 — integration tests for the aggregator dashboard +
 * CSV export endpoints against a real Postgres, exercising the new
 * `by_domain` response shape and the multi-domain (seeker + provider)
 * org metadata model.
 *
 * Filename ends in .integration.test.ts so the default vitest config
 * excludes it from `pnpm --filter api test`. Runs via the sibling
 * integration config:
 *
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm --filter api test:integration \
 *     src/routes/v1/aggregator/__tests__/dashboard.integration.test.ts
 *
 * The suite fully self-contains the world it exercises:
 *
 *   - Seeds one aggregator-type org with
 *     `metadata.domains = ['seeker', 'provider']` plus one
 *     network_service-type org (needed to drive /admin/participant
 *     unrestricted onboarding for provider items). Both share one
 *     service user so cleanup is a one-row delete.
 *   - Seeds 5 seeker participants + 2 provider participants via
 *     POST /api/v1/admin/participant (the network_service apikey for
 *     seekers so we can vary channel/onboarded_via, the same apikey
 *     for providers).
 *   - Drives 3 of the seekers to apply to the 2 providers via
 *     POST /api/v1/action/perform (aggregator apikey,
 *     acting_as_user_id = seeker_user_id), then mutates a subset
 *     through POST /api/v1/action/update-status to fan the
 *     action_status across `created` / `shortlisted` / `rejected`
 *     buckets.
 *   - Boots Fastify on the env-configured API_PORT (default 2742)
 *     because /action/perform loops back through HTTP to
 *     /network/action/perform on the same base URL declared by
 *     the network config (Plan A's instance_url pin).
 *
 * Cleanup: afterAll wipes item_metrics, item_actions, items, users,
 * apikey, member, organization rows in safe FK order.
 *
 * Skip conditions: if POSTGRES_URL/POSTGRES_USER are unset the suite
 * is described as `.skip` so CI without a DB stays green.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { eq, inArray, sql } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const skip_reason = !pg_url
  ? 'POSTGRES_URL / POSTGRES_USER not set — skipping integration suite'
  : '';

const describeIf = can_run ? describe : describe.skip;

const hash_key = (raw: string) =>
  createHash('sha256').update(raw).digest('base64url');

describeIf(`GET /aggregator/dashboard by_domain (integration)${
  can_run ? '' : ` — ${skip_reason}`
}`, () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../../db/postgres/schema/auth.js');
  let itemsTable: typeof import('@dpg/database').items;
  let itemActionsTable: typeof import('@dpg/database').item_actions;
  let itemMetricsTable: typeof import('../../../../../db/postgres/schema/metrics.js').item_metrics;

  // /action/perform proxies via HTTP loopback to /network/action/perform
  // using the base URL declared in the network config for blue_dot
  // (http://localhost:2742 by default). The Fastify listen port must
  // match, else INVALID_TARGET_INSTANCE fires.
  const listen_port = Number(process.env.API_PORT ?? 2742);
  const base_url = `http://localhost:${listen_port}`;

  const ts = Date.now();

  // Aggregator with both seeker + provider domains configured.
  const agg = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `agg-int-b12-${ts}`,
  };

  // Network service org — used by /admin/participant for unrestricted
  // onboarding (lets us pick channel, domain, item_type freely).
  const ns = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `ns-int-b12-${ts}`,
  };

  // Shared service user backing both apikeys / members.
  const svc_user_id = `usr_${randomUUID()}`;
  const svc_user_email = `signals-b12-int-${ts}@signals.local`;

  // Per-run tracking so cleanup can scope deletes.
  const seeker_user_ids: string[] = [];
  const provider_user_ids: string[] = [];
  const seeker_item_ids: string[] = [];
  const provider_item_ids: string[] = [];
  const action_ids: string[] = [];

  // Channels we cycle through to populate item_metrics.onboarded_via
  // and the dashboard's mode_wise_counts.
  const seeker_channels = ['bulk', 'link', 'voice', 'bulk', 'link'] as const;

  beforeAll(async () => {
    // Lazy imports — drizzle_config constructs a Pool eagerly on import,
    // so we can't do this at module load when the suite is skipped.
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    const auth_mod = await import('../../../../../db/postgres/schema/auth.js');
    const database_pkg = await import('@dpg/database');
    const metrics_mod = await import(
      '../../../../../db/postgres/schema/metrics.js'
    );
    db = drizzle_mod.db;
    authSchema = auth_mod;
    itemsTable = database_pkg.items;
    itemActionsTable = database_pkg.item_actions;
    itemMetricsTable = metrics_mod.item_metrics;

    const { admin_routes } = await import('../../admin/admin_routes.js');
    const action_routes_mod = await import('../../action/action_routes.js');
    const network_routes_mod = await import(
      '../../network/network_routes.js'
    );
    const { aggregator_routes } = await import('../aggregator_routes.js');

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(admin_routes, { prefix: '/api/v1/admin' });
    await app.register(action_routes_mod.default, {
      prefix: '/api/v1/action',
    });
    await app.register(network_routes_mod.default, {
      prefix: '/api/v1/network',
    });
    await app.register(aggregator_routes, { prefix: '/api/v1/aggregator' });

    try {
      await app.listen({ port: listen_port, host: '127.0.0.1' });
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e?.code === 'EADDRINUSE') {
        throw new Error(
          `integration test requires port ${listen_port} to be free ` +
            `(set API_PORT). Is the dev server already running?`,
        );
      }
      throw err;
    }

    const { user, organization, member, apikey } = authSchema;
    const now = new Date();

    // One shared service user for both apikeys.
    await db.insert(user).values({
      id: svc_user_id,
      email: svc_user_email,
      name: 'plan-b12 integration svc',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    // Aggregator with both domains configured. metadata is a JSON string
    // (better-auth's text column). The dashboard parses it and reads
    // meta.domains.
    await db.insert(organization).values([
      {
        id: agg.org_id,
        slug: agg.slug,
        name: `${agg.slug} (integration aggregator multi-domain)`,
        type: 'aggregator',
        metadata: JSON.stringify({
          external_id: `agg_b12_${ts}`,
          domains: ['seeker', 'provider'],
        }),
        createdAt: now,
      },
      {
        id: ns.org_id,
        slug: ns.slug,
        name: `${ns.slug} (integration network_service)`,
        type: 'network_service',
        createdAt: now,
      },
    ]);

    await db.insert(member).values([
      {
        id: agg.member_id,
        organizationId: agg.org_id,
        userId: svc_user_id,
        role: 'service',
        createdAt: now,
      },
      {
        id: ns.member_id,
        organizationId: ns.org_id,
        userId: svc_user_id,
        role: 'service',
        createdAt: now,
      },
    ]);

    for (const v of [agg, ns]) {
      await db.insert(apikey).values({
        id: v.apikey_id,
        name: v.slug,
        key: hash_key(v.raw_key),
        userId: svc_user_id,
        referenceId: svc_user_id,
        configId: 'default',
        start: v.raw_key.slice(0, 6),
        prefix: 'sk_signals_',
        enabled: true,
        rateLimitEnabled: false,
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  afterAll(async () => {
    const { user, organization, member, apikey } = authSchema;
    try {
      // FK order: item_metrics has no FK on items or users (text column
      // soft reference), so delete those first explicitly by
      // onboarded_by_org_id. item_actions has FK ON DELETE CASCADE on
      // items via the target side; we still drop by source_item_owner
      // first for the seeker action rows.
      await db
        .delete(itemMetricsTable)
        .where(eq(itemMetricsTable.onboardedByOrgId, agg.org_id));

      const all_participant_ids = [
        ...seeker_user_ids,
        ...provider_user_ids,
      ];
      if (all_participant_ids.length > 0) {
        await db
          .delete(itemActionsTable)
          .where(
            inArray(
              itemActionsTable.source_item_owner,
              all_participant_ids,
            ),
          );
        await db
          .delete(itemsTable)
          .where(inArray(itemsTable.created_by, all_participant_ids));
        await db.delete(user).where(inArray(user.id, all_participant_ids));
      }

      await db
        .delete(apikey)
        .where(inArray(apikey.id, [agg.apikey_id, ns.apikey_id]));
      await db
        .delete(member)
        .where(inArray(member.id, [agg.member_id, ns.member_id]));
      await db.delete(user).where(eq(user.id, svc_user_id));
      await db
        .delete(organization)
        .where(inArray(organization.id, [agg.org_id, ns.org_id]));
    } catch (err) {
      // Don't mask test failures with cleanup blow-ups.
      // eslint-disable-next-line no-console
      console.error('integration test cleanup failed:', err);
    }
    if (app) await app.close();
  });

  // Phone-number helpers — keep them unique-per-run to avoid 23505s.
  const seeker_phone = (i: number) =>
    `+919930${String(100000 + i + ((ts % 1000) * 13)).slice(-6)}`;
  const provider_phone = (i: number) =>
    `+919940${String(100000 + i + ((ts % 1000) * 17)).slice(-6)}`;

  it('seeds 5 seekers + 2 providers via /admin/participant (network_service apikey)', async () => {
    // We seed via the network_service apikey because admin/participant's
    // NS tier accepts arbitrary network/domain/item_type combos and lets
    // us vary `channel` freely (the aggregator tier coerces channel='bulk'
    // and doesn't expose domain / item_type). NS onboarding writes
    // user.onboarded_by_org_id = ns.org_id; we then re-attribute every
    // seeded user to the aggregator org via direct UPDATE so the
    // recompute (which joins on u.onboarded_by_org_id = aggregator_id)
    // picks them up.

    // 5 seekers — channels cycle across bulk/link/voice for a
    // non-trivial mode_wise_counts histogram in test 3.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/participant',
        headers: {
          'x-api-key': ns.raw_key,
          'x-acting-org-id': ns.org_id,
          'content-type': 'application/json',
        },
        payload: {
          phone_number: seeker_phone(i),
          name: `B12 Seeker ${i}`,
          terms_accepted: true,
          privacy_accepted: true,
          channel: seeker_channels[i],
          network: 'blue_dot',
          domain: 'seeker',
          item_type: 'profile_1.0',
          item_state: {
            name: `B12 Seeker ${i}`,
            gender: i % 2 === 0 ? 'female' : 'male',
            location: 'Bangalore',
            phone: `99300000${String(10 + i).slice(-2)}`,
            age: 22 + i,
          },
        },
      });
      if (res.statusCode !== 200) {
        throw new Error(
          `seed seeker ${i} via NS failed: ${res.statusCode} ${res.body}`,
        );
      }
      const body = res.json();
      seeker_user_ids.push(body.user_id);
      seeker_item_ids.push(body.items[0].item_id);
    }
    expect(seeker_user_ids).toHaveLength(5);
    expect(seeker_item_ids).toHaveLength(5);

    // 2 providers — job_posting_1.0 items.
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/participant',
        headers: {
          'x-api-key': ns.raw_key,
          'x-acting-org-id': ns.org_id,
          'content-type': 'application/json',
        },
        payload: {
          phone_number: provider_phone(i),
          name: `B12 Provider ${i}`,
          terms_accepted: true,
          privacy_accepted: true,
          channel: 'bulk',
          network: 'blue_dot',
          domain: 'provider',
          item_type: 'job_posting_1.0',
          item_state: {
            jobProviderName: `B12 Provider ${i} Co`,
            jobProviderLocation: 'Bangalore',
            hiringManagerName: `B12 HM ${i}`,
            hiringManagerPhoneNumber: `99400000${String(10 + i).slice(-2)}`,
            hiringManagerEmail: `hm${i}@b12.integration.test`,
            role: 'Helper',
            positions: 2,
            natureOfJob: 'Full-time',
          },
        },
      });
      if (res.statusCode !== 200) {
        throw new Error(
          `seed provider ${i} failed: ${res.statusCode} ${res.body}`,
        );
      }
      const body = res.json();
      provider_user_ids.push(body.user_id);
      provider_item_ids.push(body.items[0].item_id);
    }
    expect(provider_user_ids).toHaveLength(2);
    expect(provider_item_ids).toHaveLength(2);

    // Re-attribute every seeded user from ns.org_id to agg.org_id so
    // recompute (which filters by u.onboarded_by_org_id) sees them.
    const { user } = authSchema;
    await db
      .update(user)
      .set({ onboardedByOrgId: agg.org_id })
      .where(
        inArray(user.id, [...seeker_user_ids, ...provider_user_ids]),
      );
  });

  it('3 seekers apply to the 2 providers, then update-status fans across created/shortlisted/rejected', async () => {
    // 6 apply actions: seekers 0,1,2 each applying to providers 0,1.
    // The action_status will be set via update-status below to land:
    //   - 2 'shortlisted'
    //   - 2 'rejected'
    //   - 2 left as 'created' (matches the 'pending' metric_categories
    //     bucket per blue_dot/network.json: ['created','submitted'])
    for (let s = 0; s < 3; s++) {
      for (let p = 0; p < 2; p++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/action/perform',
          headers: {
            'x-api-key': agg.raw_key,
            'x-acting-org-id': agg.org_id,
            'content-type': 'application/json',
          },
          payload: {
            action_type: 'apply',
            source_item: {
              item_network: 'blue_dot',
              item_domain: 'seeker',
              item_type: 'profile_1.0',
              item_id: seeker_item_ids[s],
            },
            target_item: {
              item_network: 'blue_dot',
              item_domain: 'provider',
              item_type: 'job_posting_1.0',
              item_id: provider_item_ids[p],
              item_instance_url: base_url,
            },
            requirements_snapshot: {
              role: 'Helper',
              age: 22 + s,
              workExperience: 'Fresher',
            },
            acting_as_user_id: seeker_user_ids[s],
          },
        });
        if (res.statusCode !== 201) {
          throw new Error(
            `apply (${s}→${p}) failed: ${res.statusCode} ${res.body}`,
          );
        }
        action_ids.push(res.json().action_id);
      }
    }
    expect(action_ids).toHaveLength(6);

    // Fan status across buckets. update-status enforces
    // target_item_owner === effective_user_id, so the aggregator must
    // pass acting_as_user_id = the provider's user_id. The providers
    // were re-attributed to agg.org_id in the seeding step, so
    // resolve_acting_actor returns ok (onboarded_by === agg.org_id).
    const status_plan = [
      { i: 0, status: 'shortlisted' },
      { i: 1, status: 'rejected' },
      { i: 2, status: 'shortlisted' },
      { i: 3, status: 'rejected' },
      // i=4, i=5 left as 'created'
    ];

    for (const { i, status } of status_plan) {
      // action_ids are ordered by seeker, then provider:
      //   i=0 → seeker 0 → provider 0
      //   i=1 → seeker 0 → provider 1
      //   i=2 → seeker 1 → provider 0
      //   i=3 → seeker 1 → provider 1
      const provider_idx = i % 2;
      const provider_uid = provider_user_ids[provider_idx];
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/action/update-status',
        headers: {
          'x-api-key': agg.raw_key,
          'x-acting-org-id': agg.org_id,
          'content-type': 'application/json',
        },
        payload: {
          action_id: action_ids[i],
          action_status: status,
          remarks: `b12 fan to ${status}`,
          acting_as_user_id: provider_uid,
        },
      });
      if (res.statusCode !== 200) {
        throw new Error(
          `update-status (${i}→${status}) failed: ${res.statusCode} ${res.body}`,
        );
      }
    }
  });

  it('GET /aggregator/dashboard returns by_domain with seeker + provider rollups populated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/aggregator/dashboard',
      headers: {
        'x-api-key': agg.raw_key,
        'x-acting-org-id': agg.org_id,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      by_domain: Record<
        string,
        {
          rollup: {
            items_total: number;
            applications_total: number;
            applications_shortlisted: number;
            applications_rejected: number;
            applications_pending: number;
            by_status: Record<string, number>;
            mode_wise_counts: Record<string, number>;
          };
          participants: Array<{ owner_user_id: string }>;
          total_matching: number;
        }
      >;
      metadata: {
        last_computed_at: string | null;
        ttl_seconds: number;
        refreshed: boolean;
      };
    };

    expect(Object.keys(body.by_domain).sort()).toEqual(['provider', 'seeker']);
    expect(body.by_domain.seeker.rollup.items_total).toBe(5);
    expect(body.by_domain.provider.rollup.items_total).toBe(2);

    // applications_total per domain:
    //   seeker: 6 (each seeker row counts every action where the seeker
    //     was the source; 3 seekers × 2 providers = 6 actions, summed
    //     across the 3 active seekers).
    //   provider: 6 (each provider was the target of 3 actions; sum
    //     across the 2 providers = 6).
    expect(
      body.by_domain.seeker.rollup.applications_total,
    ).toBeGreaterThanOrEqual(6);
    expect(
      body.by_domain.provider.rollup.applications_total,
    ).toBeGreaterThanOrEqual(6);
    // shortlisted (2) + rejected (2) + pending (2) = 6.
    expect(
      body.by_domain.seeker.rollup.applications_shortlisted,
    ).toBeGreaterThanOrEqual(2);
    expect(
      body.by_domain.seeker.rollup.applications_rejected,
    ).toBeGreaterThanOrEqual(2);
    expect(
      body.by_domain.provider.rollup.applications_shortlisted,
    ).toBeGreaterThanOrEqual(2);
    expect(
      body.by_domain.provider.rollup.applications_rejected,
    ).toBeGreaterThanOrEqual(2);

    // by_status is non-empty per domain (every row has SOME profile_status
    // bucket, even if it's just 'new' or 'inactive').
    expect(Object.keys(body.by_domain.seeker.rollup.by_status).length).toBeGreaterThan(
      0,
    );
    expect(
      Object.keys(body.by_domain.provider.rollup.by_status).length,
    ).toBeGreaterThan(0);

    // metadata.refreshed should be true on first hit (no prior rows).
    expect(body.metadata.refreshed).toBe(true);
    expect(typeof body.metadata.ttl_seconds).toBe('number');
  });

  it('force-stale via SQL bump → next /dashboard call recomputes again (refreshed=true)', async () => {
    await db.execute(sql`
      UPDATE item_metrics
         SET last_computed_at = NOW() - INTERVAL '2 hours'
       WHERE onboarded_by_org_id = ${agg.org_id}
    `);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/aggregator/dashboard',
      headers: {
        'x-api-key': agg.raw_key,
        'x-acting-org-id': agg.org_id,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      metadata: { refreshed: boolean; last_computed_at: string | null };
    };
    expect(body.metadata.refreshed).toBe(true);
    expect(body.metadata.last_computed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('?domain=seeker scopes by_domain to a single key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/aggregator/dashboard?domain=seeker',
      headers: {
        'x-api-key': agg.raw_key,
        'x-acting-org-id': agg.org_id,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      by_domain: Record<string, unknown>;
    };
    expect(Object.keys(body.by_domain)).toEqual(['seeker']);
    expect(body.by_domain.provider).toBeUndefined();
  });

  it('GET /aggregator/dashboard/export returns CSV with the 20-column header and rows across both domains', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/aggregator/dashboard/export',
      headers: {
        'x-api-key': agg.raw_key,
        'x-acting-org-id': agg.org_id,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);

    const body = res.body;
    const lines = body.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);

    // Header line: 20 columns per export.ts COLUMNS list.
    const header_cols = lines[0].split(',');
    expect(header_cols).toEqual([
      'item_id',
      'item_domain',
      'item_type',
      'owner_user_id',
      'onboarded_by_org_id',
      'onboarded_via',
      'profile_status',
      'profile_completion_pct',
      'profile_created_at',
      'profile_last_updated_at',
      'age_days',
      'applications_total',
      'applications_pending',
      'applications_shortlisted',
      'applications_rejected',
      'last_applied_at',
      'last_shortlisted_at',
      'last_rejected_at',
      'openings',
      'actionable_tags',
    ]);

    // item_domain is column index 1 in each row. We expect both
    // 'seeker' and 'provider' values to appear among the data rows
    // (export.ts orders by item_domain ASC so providers come first
    // alphabetically, then seekers).
    const data_rows = lines.slice(1);
    expect(data_rows.length).toBeGreaterThanOrEqual(5 + 2);
    const domains_seen = new Set(data_rows.map((r) => r.split(',')[1]));
    expect(domains_seen.has('seeker')).toBe(true);
    expect(domains_seen.has('provider')).toBe(true);
  });
});
