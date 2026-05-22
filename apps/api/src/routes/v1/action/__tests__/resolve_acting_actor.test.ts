import { describe, it, expect } from 'vitest';
import { resolve_acting_actor } from '../_resolve_acting_actor.js';

const baseAggregator = {
  org_id: 'org_bbmp',
  org_type: 'aggregator' as const,
  service_user_id: 'svc_agg',
};
const baseVoice = {
  org_id: 'org_voice_1',
  org_type: 'voice' as const,
  service_user_id: 'svc_voice_1',
};
const baseNetwork = {
  org_id: 'org_signals',
  org_type: 'network_service' as const,
  service_user_id: 'svc_signals',
};

const lookupOnboarded = async (user_id: string): Promise<string | null> => {
  if (user_id === 'usr_voice_owned') return 'org_voice_1';
  if (user_id === 'usr_other_voice_owned') return 'org_voice_2';
  if (user_id === 'usr_no_attribution') return null;
  return null;
};

describe('resolve_acting_actor', () => {
  it('self-acted: no acting_org and no acting_as_user_id → effective_user = request.user', async () => {
    const res = await resolve_acting_actor({
      acting_org: undefined,
      request_user_id: 'usr_self',
      acting_as_user_id: undefined,
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({
      ok: true,
      effective_user_id: 'usr_self',
      audit: { performed_by_org_id: null, performed_by_service_user_id: null },
    });
  });

  it('no acting_org + body field present → 400 CANNOT_OVERRIDE_SELF', async () => {
    const res = await resolve_acting_actor({
      acting_org: undefined,
      request_user_id: 'usr_self',
      acting_as_user_id: 'usr_target',
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({ ok: false, status: 400, error: 'CANNOT_OVERRIDE_SELF' });
  });

  it('aggregator acting_org → 403 ACTING_ORG_TYPE_NOT_ALLOWED (regardless of body field)', async () => {
    const res1 = await resolve_acting_actor({
      acting_org: baseAggregator,
      request_user_id: 'svc_agg',
      acting_as_user_id: 'usr_voice_owned',
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res1).toEqual({ ok: false, status: 403, error: 'ACTING_ORG_TYPE_NOT_ALLOWED' });

    const res2 = await resolve_acting_actor({
      acting_org: baseAggregator,
      request_user_id: 'svc_agg',
      acting_as_user_id: undefined,
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res2).toEqual({ ok: false, status: 403, error: 'ACTING_ORG_TYPE_NOT_ALLOWED' });
  });

  it('network_service acting_org → 403 ACTING_ORG_TYPE_NOT_ALLOWED', async () => {
    const res = await resolve_acting_actor({
      acting_org: baseNetwork,
      request_user_id: 'svc_signals',
      acting_as_user_id: 'usr_voice_owned',
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({ ok: false, status: 403, error: 'ACTING_ORG_TYPE_NOT_ALLOWED' });
  });

  it('voice acting_org + missing body field → 400 MISSING_ACTING_AS_USER_ID', async () => {
    const res = await resolve_acting_actor({
      acting_org: baseVoice,
      request_user_id: 'svc_voice_1',
      acting_as_user_id: undefined,
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({ ok: false, status: 400, error: 'MISSING_ACTING_AS_USER_ID' });
  });

  it('voice acting_org + target onboarded by THIS voice org → success, audit populated', async () => {
    const res = await resolve_acting_actor({
      acting_org: baseVoice,
      request_user_id: 'svc_voice_1',
      acting_as_user_id: 'usr_voice_owned',
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({
      ok: true,
      effective_user_id: 'usr_voice_owned',
      audit: {
        performed_by_org_id: 'org_voice_1',
        performed_by_service_user_id: 'svc_voice_1',
      },
    });
  });

  it('voice acting_org + target onboarded by ANOTHER voice org → 403 NOT_AUTHORIZED_FOR_TARGET', async () => {
    const res = await resolve_acting_actor({
      acting_org: baseVoice,
      request_user_id: 'svc_voice_1',
      acting_as_user_id: 'usr_other_voice_owned',
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({ ok: false, status: 403, error: 'NOT_AUTHORIZED_FOR_TARGET' });
  });

  it('voice acting_org + target with NULL onboarded_by → 403 NOT_AUTHORIZED_FOR_TARGET', async () => {
    const res = await resolve_acting_actor({
      acting_org: baseVoice,
      request_user_id: 'svc_voice_1',
      acting_as_user_id: 'usr_no_attribution',
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({ ok: false, status: 403, error: 'NOT_AUTHORIZED_FOR_TARGET' });
  });

  it('voice acting_org + target_user_id not found at all → 403 NOT_AUTHORIZED_FOR_TARGET', async () => {
    const res = await resolve_acting_actor({
      acting_org: baseVoice,
      request_user_id: 'svc_voice_1',
      acting_as_user_id: 'usr_does_not_exist',
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({ ok: false, status: 403, error: 'NOT_AUTHORIZED_FOR_TARGET' });
  });
});
