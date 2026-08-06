import { describe, it, expect, vi } from 'vitest';

vi.mock('@api/db/postgres/drizzle_config', () => ({ db: {} }));
vi.mock('@api/db/postgres/schema/auth', () => ({ user: {} }));

import { resolve_acting_actor } from '../_resolve_acting_actor.js';

const aggregator = {
  org_id: 'org_agg_a',
  org_type: 'aggregator' as const,
  service_user_id: 'svc_agg',
};
const network_service = {
  org_id: 'org_signals',
  org_type: 'network_service' as const,
  service_user_id: 'svc_ns',
};
const voice = {
  org_id: 'org_voice_x',
  org_type: 'voice' as const,
  service_user_id: 'svc_voice',
};

const lookup_user_factory = (
  rows: Record<string, { onboardedByOrgId: string | null }>,
) =>
  vi.fn(async (uid: string) => rows[uid] ?? null);

describe('resolve_acting_actor', () => {
  describe('self-acted (no acting_org)', () => {
    it('returns effective_user_id = request_user_id when no body field', async () => {
      const result = await resolve_acting_actor({
        acting_org: undefined,
        request_user_id: 'usr_self',
        acting_as_user_id: undefined,
        lookup_user: lookup_user_factory({}),
      });
      expect(result).toEqual({
        ok: true,
        effective_user_id: 'usr_self',
        audit: { performed_by_org_id: null, performed_by_service_user_id: null },
      });
    });

    it('400 CANNOT_OVERRIDE_SELF when body field present', async () => {
      const result = await resolve_acting_actor({
        acting_org: undefined,
        request_user_id: 'usr_self',
        acting_as_user_id: 'usr_other',
        lookup_user: lookup_user_factory({}),
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        error: 'CANNOT_OVERRIDE_SELF',
      });
    });
  });

  describe('tier gate', () => {
    it('admits voice, and does NOT apply the aggregator ownership rule to it', async () => {
      // voice-dpg is an integrating DPG on the same client-credentials footing
      // as the aggregator. It behaves like network_service here: no
      // onboarded_by_org_id check, because "the org that onboarded this user"
      // has no voice equivalent — note the target below is onboarded by a
      // DIFFERENT org and is still allowed.
      const result = await resolve_acting_actor({
        acting_org: voice,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_target',
        lookup_user: lookup_user_factory({
          usr_target: { onboardedByOrgId: 'org_someone_else' },
        }),
      });
      expect(result).toEqual({
        ok: true,
        effective_user_id: 'usr_target',
        audit: {
          performed_by_org_id: voice.org_id,
          performed_by_service_user_id: voice.service_user_id,
        },
      });
    });

    it('still rejects an org type outside the allowed set', async () => {
      const result = await resolve_acting_actor({
        acting_org: {
          org_id: 'org_employer_1',
          org_type: 'employer' as unknown as typeof aggregator.org_type,
          service_user_id: 'svc_emp',
        },
        request_user_id: 'svc',
        acting_as_user_id: 'usr_target',
        lookup_user: lookup_user_factory({
          usr_target: { onboardedByOrgId: null },
        }),
      });
      expect(result).toEqual({
        ok: false,
        status: 403,
        error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
      });
    });

    it('400 MISSING_ACTING_AS_USER_ID for aggregator', async () => {
      const result = await resolve_acting_actor({
        acting_org: aggregator,
        request_user_id: 'svc',
        acting_as_user_id: undefined,
        lookup_user: lookup_user_factory({}),
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        error: 'MISSING_ACTING_AS_USER_ID',
      });
    });

    it('400 MISSING_ACTING_AS_USER_ID for network_service', async () => {
      const result = await resolve_acting_actor({
        acting_org: network_service,
        request_user_id: 'svc',
        acting_as_user_id: undefined,
        lookup_user: lookup_user_factory({}),
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        error: 'MISSING_ACTING_AS_USER_ID',
      });
    });
  });

  describe('user existence', () => {
    it('404 USER_NOT_FOUND for aggregator + missing user', async () => {
      const result = await resolve_acting_actor({
        acting_org: aggregator,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_missing',
        lookup_user: lookup_user_factory({}),
      });
      expect(result).toEqual({
        ok: false,
        status: 404,
        error: 'USER_NOT_FOUND',
      });
    });

    it('404 USER_NOT_FOUND for network_service + missing user', async () => {
      const result = await resolve_acting_actor({
        acting_org: network_service,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_missing',
        lookup_user: lookup_user_factory({}),
      });
      expect(result).toEqual({
        ok: false,
        status: 404,
        error: 'USER_NOT_FOUND',
      });
    });
  });

  describe('aggregator tier', () => {
    it('happy path: user onboarded by this aggregator', async () => {
      const result = await resolve_acting_actor({
        acting_org: aggregator,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_a',
        lookup_user: lookup_user_factory({
          usr_a: { onboardedByOrgId: 'org_agg_a' },
        }),
      });
      expect(result).toEqual({
        ok: true,
        effective_user_id: 'usr_a',
        audit: {
          performed_by_org_id: 'org_agg_a',
          performed_by_service_user_id: 'svc_agg',
        },
      });
    });

    it('403 NOT_AUTHORIZED_FOR_TARGET when user onboarded by another aggregator', async () => {
      const result = await resolve_acting_actor({
        acting_org: aggregator,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_other_agg',
        lookup_user: lookup_user_factory({
          usr_other_agg: { onboardedByOrgId: 'org_agg_b' },
        }),
      });
      expect(result).toEqual({
        ok: false,
        status: 403,
        error: 'NOT_AUTHORIZED_FOR_TARGET',
      });
    });

    it('403 NOT_AUTHORIZED_FOR_TARGET when user is self-registered (onboarded_by null)', async () => {
      const result = await resolve_acting_actor({
        acting_org: aggregator,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_self_reg',
        lookup_user: lookup_user_factory({
          usr_self_reg: { onboardedByOrgId: null },
        }),
      });
      expect(result).toEqual({
        ok: false,
        status: 403,
        error: 'NOT_AUTHORIZED_FOR_TARGET',
      });
    });
  });

  describe('network_service tier', () => {
    it('happy path: any user in the network (own aggregator)', async () => {
      const result = await resolve_acting_actor({
        acting_org: network_service,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_a',
        lookup_user: lookup_user_factory({
          usr_a: { onboardedByOrgId: 'org_agg_a' },
        }),
      });
      expect(result).toEqual({
        ok: true,
        effective_user_id: 'usr_a',
        audit: {
          performed_by_org_id: 'org_signals',
          performed_by_service_user_id: 'svc_ns',
        },
      });
    });

    it('happy path: any user in the network (cross-aggregator user)', async () => {
      const result = await resolve_acting_actor({
        acting_org: network_service,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_other_agg',
        lookup_user: lookup_user_factory({
          usr_other_agg: { onboardedByOrgId: 'org_agg_b' },
        }),
      });
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({
        effective_user_id: 'usr_other_agg',
        audit: { performed_by_org_id: 'org_signals' },
      });
    });

    it('happy path: any user in the network (self-registered user)', async () => {
      const result = await resolve_acting_actor({
        acting_org: network_service,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_self_reg',
        lookup_user: lookup_user_factory({
          usr_self_reg: { onboardedByOrgId: null },
        }),
      });
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({
        effective_user_id: 'usr_self_reg',
        audit: { performed_by_org_id: 'org_signals' },
      });
    });
  });

  describe('branch-order safety', () => {
    it('lookup_user is NOT called when body field is missing', async () => {
      const spy = lookup_user_factory({});
      await resolve_acting_actor({
        acting_org: aggregator,
        request_user_id: 'svc',
        acting_as_user_id: undefined,
        lookup_user: spy,
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it('lookup_user IS called for network_service when body field is present', async () => {
      const spy = lookup_user_factory({
        usr_a: { onboardedByOrgId: null },
      });
      await resolve_acting_actor({
        acting_org: network_service,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_a',
        lookup_user: spy,
      });
      expect(spy).toHaveBeenCalledWith('usr_a');
    });
  });
});
