import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';
import { performAction, tryPerformAction, updateActionStatus } from '../../src/actions.js';

/**
 * Journey R — action limits & the owned-action list (P0).
 *
 * **The pair cap (#370, orig #422).** `services/action_pair_cap.ts` allows at
 * most `max_actions_per_pair` (unset ⇒ 1) *open* actions between an item pair.
 * Three properties make it correct, and all three can fail independently:
 *
 *  1. it blocks at the cap,
 *  2. it is **bidirectional** — B→A counts against the same budget as A→B
 *     (a per-direction implementation passes (1) and fails here),
 *  3. it **releases** once the open action reaches a terminal status
 *     (a cap that never frees also passes (1) — and permanently bricks the pair).
 *
 * The error surfaces through two hops: the network handler returns 409
 * `ACTION_LIMIT_REACHED`, and the instance-local `/action/perform` re-wraps it as
 * a `BulkItemFailure`, so the client sees a 422 envelope with the code on
 * `results[0].error` — not a top-level 409.
 *
 * The cap is read from network config and is not exposed over the API, so these
 * tests **discover** it by performing until refused rather than assuming 1.
 */
test.describe('Journey R — action limits & the action list', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users (gated target without service creds)');
  test.skip(({ caps }) => !caps.testOtp, 'requires OTP retrieval (CREATE_TEST_OTP on the target)');

  const BOUND = 6;

  /**
   * Why the cap tests skip rather than fail when nothing is refused.
   *
   * `max_actions_per_pair` defaults to 1, so on a target that HAS the feature the
   * second perform is refused. Opening {@link BOUND} in a row therefore almost
   * always means the target predates #479 rather than that it configured a high
   * cap — that is what a stale local image looks like, and it is a target
   * problem, not a product bug. Verify with:
   *   docker exec <api> grep -rl ACTION_LIMIT_REACHED /app
   */
  const NO_CAP_REASON =
    `${BOUND} actions opened on one pair without refusal — target predates the pair cap (#370/#422) ` +
    'or sets max_actions_per_pair above the probe bound; rebuild/upgrade the target to exercise this';

  /**
   * Perform on the pair until it is refused.
   *
   * `exhausted` means the bound was hit with every attempt succeeding — the only
   * honest reason to skip. Any *refusal* is returned verbatim (status + body) so
   * the caller can assert it is the cap; an earlier version collapsed "refused
   * for some other reason" into the same shape as "never refused", which turned
   * a genuine failure into a green skip.
   */
  const fillPair = async (
    from: Awaited<ReturnType<typeof createLiveProfileUser>>,
    to: Awaited<ReturnType<typeof createLiveProfileUser>>,
    actionType: string,
  ): Promise<{
    opened: string[];
    exhausted: boolean;
    refusal?: { error?: string; message?: string; httpStatus: number; body: unknown };
  }> => {
    const opened: string[] = [];
    for (let i = 0; i < BOUND; i++) {
      const { res, result } = await tryPerformAction(from.session, {
        actionType,
        source: from.sourceRef,
        target: to.targetRef,
      });
      if (result?.status === 'success' && result.action_id) {
        opened.push(result.action_id);
        continue;
      }
      return {
        opened,
        exhausted: false,
        refusal: { error: result?.error, message: result?.message, httpStatus: res.status, body: res.body },
      };
    }
    return { opened, exhausted: true };
  };

  /** Assert the pair was refused *by the cap*, surfacing the real body if not. */
  const expectCapRefusal = (r: Awaited<ReturnType<typeof fillPair>>) => {
    expect(
      r.refusal?.error,
      `expected ACTION_LIMIT_REACHED after ${r.opened.length} open action(s); ` +
        `got HTTP ${r.refusal?.httpStatus} ${JSON.stringify(r.refusal?.body)}`,
    ).toBe('ACTION_LIMIT_REACHED');
  };

  test('an item pair is capped at its open-action budget', async ({ api, service, cfg, caps, authCtx }) => {
    const a = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[0], label: 'rcapa' });
    const b = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[1] ?? cfg.servedDomains[0], label: 'rcapb' });

    const filled = await fillPair(a, b, cfg.action.type);

    test.skip(filled.exhausted, `no pair cap bit within ${BOUND} actions — target sets max_actions_per_pair high or unenforced`);
    expect(filled.opened.length, 'at least one action must get through before the cap bites').toBeGreaterThan(0);
    expectCapRefusal(filled);
  });

  test('the cap is bidirectional — the reverse direction shares one budget', async ({ api, service, cfg, caps, authCtx }) => {
    // Needs a SYMMETRIC interaction (same domain at both ends). With a
    // directional one the reverse perform is refused on interaction shape long
    // before the cap is consulted, so the assertion would be vacuous — which is
    // exactly what happened with blue_dot `apply` (seeker→provider only).
    const sym = cfg.symmetricAction;
    test.skip(
      !sym,
      'no symmetricAction configured — set config.symmetricAction to an interaction whose from/to domains match (blue_dot: connect between two providers)',
    );

    const a = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: sym!.domainKey, label: 'rbia' });
    const b = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: sym!.domainKey, label: 'rbib' });

    const forward = await fillPair(a, b, sym!.type);
    test.skip(forward.exhausted, NO_CAP_REASON);
    expectCapRefusal(forward);

    // B → A, the same interaction reversed. A per-direction cap allows this
    // happily; one budget per unordered pair is the invariant.
    const { res, result } = await tryPerformAction(b.session, {
      actionType: sym!.type,
      source: b.sourceRef,
      target: a.targetRef,
    });
    expect(
      result?.status,
      'B→A must be refused while an A→B action is open — the cap is per pair, not per direction. ' +
        `Got HTTP ${res.status} ${JSON.stringify(res.body)}`,
    ).toBe('error');
    expect(result?.error).toBe('ACTION_LIMIT_REACHED');
  });

  test('the cap releases once the open action reaches a terminal status', async ({ api, service, cfg, caps, authCtx }) => {
    const a = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[0], label: 'rrela' });
    const b = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[1] ?? cfg.servedDomains[0], label: 'rrelb' });

    const filled = await fillPair(a, b, cfg.action.type);
    test.skip(filled.exhausted, NO_CAP_REASON);
    expectCapRefusal(filled);

    // Close every open action on the pair — the receiver accepts.
    for (const actionId of filled.opened) {
      await updateActionStatus(b.session, { actionId, status: cfg.action.acceptStatus });
    }

    // …and the pair is usable again. Without this assertion a cap that never
    // frees would still pass the "blocks at the cap" test above.
    const reopened = await tryPerformAction(a.session, {
      actionType: cfg.action.type,
      source: a.sourceRef,
      target: b.targetRef,
    });
    expect(
      reopened.result?.status,
      `a closed action must free the pair, got: ${JSON.stringify(reopened.result)}`,
    ).toBe('success');
  });

  test('the owned-action list requires authentication', async ({ api }) => {
    const res = await api.get<{ error?: string; actions?: unknown[] }>('/api/v1/action/fetch');
    expect(res.status).toBe(401);
    // NOTE: the body is Fastify's generic `{ error: 'Unauthorized' }`, NOT the
    // handler's `UNAUTHORIZED`. `auth_middleware_if_enabled` runs as a preHandler
    // and rejects first, so the handler's own 401 branch is unreachable over
    // HTTP. Asserting the handler's code here would test code that never runs.
    expect(res.body?.error).toBeTruthy();
    expect(res.body?.actions, 'no action data may accompany a 401').toBeUndefined();
  });

  test('the owned-action list is participant-scoped and tags ownership', async ({ api, service, cfg, caps, authCtx }) => {
    const source = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[0], label: 'rlsrc' });
    const target = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[1] ?? cfg.servedDomains[0], label: 'rltgt' });
    const stranger = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[0], label: 'rlstr' });

    const { actionId } = await performAction(source.session, {
      actionType: cfg.action.type,
      source: source.sourceRef,
      target: target.targetRef,
    });

    interface ActionList {
      meta: { total: number; limit: number; offset: number };
      actions: Array<{ action_id: string; ownership_roles: string[] }>;
    }
    const list = async (client: typeof source.session.client, qs = '') =>
      client.get<ActionList>(`/api/v1/action/fetch${qs}`);

    // The initiator sees it, tagged `initiated`.
    const mine = await list(source.session.client, `?action_id=${actionId}`);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const found = mine.body.actions.find((a) => a.action_id === actionId);
    expect(found, 'the initiator must see their own action').toBeTruthy();
    expect(found?.ownership_roles).toContain('initiated');

    // The receiver sees the same action, tagged `received`.
    const theirs = await list(target.session.client, `?action_id=${actionId}`);
    expect(theirs.status).toBe(200);
    expect(theirs.body.actions.find((a) => a.action_id === actionId)?.ownership_roles).toContain('received');

    // A third party must not — filtering by a known action_id is the sharpest
    // probe: an ownership leak shows up as a non-empty list, not a subtle mis-sort.
    const other = await list(stranger.session.client, `?action_id=${actionId}`);
    expect(other.status).toBe(200);
    expect(
      other.body.actions.find((a) => a.action_id === actionId),
      'a non-participant must never see another pair\'s action',
    ).toBeUndefined();
    expect(other.body.meta.total).toBe(0);

    // `ownership_role=received` must not return actions the caller initiated.
    const initiatedOnly = await list(source.session.client, '?ownership_role=received&limit=100');
    expect(initiatedOnly.status).toBe(200);
    expect(initiatedOnly.body.actions.find((a) => a.action_id === actionId)).toBeUndefined();
  });
});
