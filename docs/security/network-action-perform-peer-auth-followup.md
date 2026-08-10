# Follow-up: peer-instance auth for `POST /network/action/perform`

**Status:** deferred, not implemented. **Closes:** Issue #7 (unauthorized identity forgery) from the August 2026 security assessment.

## Current state (this PR)

`POST /api/v1/network/action/perform` (`apps/api/src/routes/v1/network/action/perform_action.ts`) is intentionally public — it's the inter-instance action-mirroring endpoint, listed in `PUBLIC_OPERATION_URLS` (`apps/api/src/app.ts`). This PR hardens the SSRF sink in `mirrorActionEventToSourceInstance` (`apps/api/src/utils/action_event_runtime.ts`) but does **not** add any authentication to the route itself.

As a result, `source_item_owner` / `target_item_owner` (and, on the inbound `perform_network_action` request body, `performed_by_org_id` / `performed_by_service_user_id`) remain **unverified request-body claims** — nothing today cryptographically binds them to the instance actually sending the request. This PR's only mitigation is audit logging these fields on every mirror attempt (`mirrorActionEventToSourceInstance`'s `identityContext`), which enables post-hoc detection, not prevention.

## The real fix

The repo already has an HMAC peer-auth mechanism used for exactly this kind of inter-instance call: `verifyInstanceToken` / `peer_instance_guard` (`apps/api/src/utils/instance_token.ts`, `apps/api/src/middleware/peer_instance_guard.ts`), currently applied only to the `*_local` routes (`network/item/count_local`, `network/item/fetch_local`). It binds a token to `timestamp + path + sha256(body)`, keyed by `INSTANCE_SHARED_SECRET`, and is governed by `PEER_AUTH_MODE` (`permissive` | `enforced`).

Converting `/network/action/perform` to require this same guard would mean: only a peer instance holding the shared secret can submit an action/event claiming a given `source_item_owner`/`target_item_owner` — the sending *instance* is accountable for its own users' claims, which is the correct trust boundary for a federated network (comparable to how email federation trusts a sending MTA for its own users, not the individual sender).

## Why this is deferred, not done here

- It's a behavior change for any existing caller of this endpoint — needs coordination with whoever currently calls it (other DPG instances / voice-dpg-style integrators) before enforcing it, unlike the SSRF hardening in this PR which is purely defensive and has no external-facing behavior change for legitimate callers.
- `PEER_AUTH_MODE` defaults to `permissive` (missing token allowed) precisely to avoid breaking un-upgraded peers during rollout — the same phased-rollout consideration applies here.

## What "done" looks like

1. Add `peer_instance_guard` as a `preHandler` on `POST /network/action/perform` (or an equivalent instance-token check), likely also removing it from `PUBLIC_OPERATION_URLS`.
2. Once enforced, `source_item_owner`/`target_item_owner`/`performed_by_*` claims are attested by an authenticated peer instance, closing issue #7.
3. Confirm with any known existing external callers before flipping `PEER_AUTH_MODE` to `enforced` for this route specifically (it may need its own mode/flag distinct from the `*_local` routes' rollout state, if callers of this route and the `*_local` routes aren't the same set of peers).
