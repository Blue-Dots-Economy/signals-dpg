---
paths:
  - "apps/api/plugins/auth/**"
  - "apps/api/src/middleware/**"
  - "packages/auth/**"
  - "apps/api/src/routes/v1/admin/**"
  - "apps/api/src/routes/auth/**"
  - "apps/api/src/routes/v1/auth/**"
---

# Auth model

Two distinct auth paths, both through `apps/api/plugins/auth/auth_middleware.ts`:

1. **Apikey path** — `x-api-key` is checked first. If present and invalid, returns `403 INVALID_API_KEY` immediately (no fallback). Used by integrating DPGs (aggregator-dpg, voice-dpg).
2. **Session path** — used by the UI when `x-api-key` is absent.

`/api/v1/admin/*` additionally requires `x-acting-org-id`, validated by `apps/api/src/middleware/acting_org.ts`. The `organization.type` column (`network_service` | `aggregator` | `voice`) gates what each acting org may do — e.g. only `network_service` may upsert aggregators. The middleware populates `request.user` and `request.acting_org`; routes should read those, not re-parse headers. `POST /api/v1/admin/participant/decrypt` returns decrypted participant profile `item_state`; ownership is keyed on the item creator's `user.onboarded_by_org_id` (aggregators see only items whose creator they onboarded; `network_service` sees all items in served networks) — never on the lazily-materialized `item_metrics` cache.

`AUTH_MIDDLEWARE_ENABLED` (default `true`) is the kill switch — useful when running migrations or seed scripts that shouldn't hit the auth path.

**Self-signup + login channels.** `SELF_SIGNUP_MODE` (default `gated`) and `LOGIN_CHANNELS` (default `phone,email`) are resolved into `authConfig` in `apps/api/src/config.ts` and enforced in the `unified_otp` plugin (`packages/auth/plugins/unified_otp.ts` → `assertSelfSignupAllowed`). `gated` (the default) blocks self-service account creation via the public OTP flow — new participants must be onboarded via `POST /api/v1/admin/participant`; `allowed` opens public self-registration. `GET /api/v1/auth/config` (public, unauthenticated, in `routes/v1/auth/auth_config.ts`) surfaces `{ selfSignupAllowed, loginChannels }` to the UI, but **server env stays the single source of truth** — never gate on the client-reported value. See `packages/auth/CLAUDE.md` for the OTP flow internals and the `assertSelfSignupAllowed` dual-call-site invariant.

**Inter-instance peer auth.** The peer-only `*_local` network routes (`network/item/count_local`, `network/item/fetch_local`) are guarded by `apps/api/src/middleware/peer_instance_guard.ts`, an HMAC instance token bound to path + body (`utils/instance_token.ts`). Signing material is `INSTANCE_SHARED_SECRET` (required, min 32, identical across a network's instances). `PEER_AUTH_MODE` (default `permissive`) allows a *missing* token during rollout but always rejects a present-but-invalid one; `enforced` requires a valid token on every peer call. The guard returns `401 PEER_AUTH_FAILED`, never throws.
