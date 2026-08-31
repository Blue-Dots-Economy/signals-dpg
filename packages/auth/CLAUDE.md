# CLAUDE.md — packages/auth

better-auth configuration + the unified OTP plugin. Root `CLAUDE.md`'s "Auth model" and "Self-signup + login channels" sections cover the *routes and headers* a caller sees; this doc covers how this package wires better-auth itself and the OTP flow underneath.

## How better-auth is wired (`src/config.ts`)

`createAuth()` builds one `betterAuth(...)` instance with:
- a Drizzle Postgres adapter (`drizzleAdapter(config.db, { provider: 'pg' })`),
- Redis as `secondaryStorage` (session + OTP storage — `get`/`set` proxy straight to the injected `redis` client),
- five plugins: `openAPI`, `bearer`, `admin`, `organization`, `unifiedOtp` (the custom plugin in `plugins/unified_otp.ts`), plus `apiKey` (from `@better-auth/api-key`).

## better-auth is pinned to the `1.6.x` line on purpose (`~1.6.29`)

`package.json` uses `~1.6.29` for `better-auth` and `@better-auth/api-key`, **not** a caret. Do not widen it back to `^` without doing the migration below — a caret lets the resolver take `1.7.x`, which is where two contracts break (#604):

- **`SecondaryStorage` gained required members.** `getAndDelete` and `increment` are optional in `@better-auth/core@1.6.x` and **required** in `1.7.x`, so the Redis adapter at `src/config.ts:70` (`get`/`set`/`delete` only) stops compiling — `TS2739`.
- **`verifyApiKey` left the inferred API surface**, breaking `apps/api/plugins/auth/auth_middleware.ts` — `TS2339`.

Both are real upstream intent, not bugs: core `1.6.x` carries `TODO(secondary-storage-atomic-consume)` and `TODO(secondary-storage-increment-required)` comments promising exactly this tightening in the next breaking release.

Two things to know before scheduling that migration. **`getAndDelete` is a security-relevant upgrade, not busywork** — `internal-adapter` uses it to consume single-use verification values atomically, and logs a warning and falls back to read-then-delete without it, so a multi-process deployment can race an OTP consume. It maps to Redis `GETDEL`; `increment` maps to `INCR` + `EXPIRE`-on-create (TTL in **seconds**, applied only on creation — later increments must not extend it). **`increment` backs secondary-storage rate limiting, which this package disables** (see the next section), so it needs a correct implementation rather than a load-bearing one.

Note this package is **not** legacy: `AUTH_PROVIDER` defaults to `betterauth` (`packages/config/src/secrets.ts`) and every Keycloak path ships dormant, so this is the live auth provider on a default deployment. Pinning is a deliberate deferral, not abandonment — patches within `1.6.x` still land.

## The instance-level rate limit is **off** — `apiKey` has its own instead

`config.ts:65-67` sets `rateLimit: { enabled: false }` on the top-level `betterAuth(...)` call — **OTP request/verify endpoints have no built-in rate limiting.** The only rate limit in this package is scoped to the separate `apiKey` plugin's config (`config.ts:12-15`: `timeWindow: 1h, maxRequests: 10000`), which governs API-key usage, not OTP attempts. This is a known gap, not an oversight to quietly "fix" by re-enabling the global limiter (which would also throttle API-key traffic in ways that config wasn't designed for) — if OTP rate limiting is ever added, it should be scoped narrowly to the OTP endpoints, not flipped on globally.

## OTP flow (`plugins/unified_otp.ts`)

- `generateOtp(isTest)` returns the fixed `'000000'` when `isTest` is true — this is the `CREATE_TEST_OTP` flag guarded by `assertCreateTestOtpSafe` (`packages/config/src/secrets.ts`'s startup guard) — never assume this path is reachable in production.
- Storage is Redis-keyed: `otp:phone:<phoneNumber>` / `otp:email:<email>`, 5-minute TTL (`expiresInSec = 5 * 60`, `unified_otp.ts:361`), written via `ctx.context.secondaryStorage.set(key, otp, expiresInSec)`.
- Verification deletes the key on success (one-time use) — a stored OTP is never reusable after a correct verify.
- **Delivery is fail-loud (#1.14).** `requestOtp` routes the send through `deliverOtp` (`plugins/otp_delivery.ts`), which **awaits** `sendPhoneOtp`/`sendEmailOtp` (email was previously fire-and-forget) and, on any send rejection, drops the just-stored OTP and throws `APIError('BAD_GATEWAY', { code: 'OTP_DELIVERY_FAILED' })`. The send callbacks in `src/config.ts` no longer swallow notification-service errors — they log and rethrow. Net effect: a failed SMS/email send returns `502` instead of `{ ok: true }` for a code that never arrived, and no stale OTP is left stranded in Redis for its full TTL. `deliverOtp` takes its deps injected so it is unit-tested without a better-auth context (`plugins/__tests__/otp_delivery.test.ts`).

## `plugins/auth_guards.ts` — two small, load-bearing guard functions

- **`assertChannelAllowed(identifier, loginChannels)`** — rejects an OTP request/verify whose identifier channel (phone vs email) isn't in the instance's `LOGIN_CHANNELS` config, before any OTP is generated.
- **`assertSelfSignupAllowed({ allowSelfSignup, email, adminByDomain })`** — the authoritative self-signup gate (see `.claude/rules/auth-model.md` for `SELF_SIGNUP_MODE`). Called at **both** `requestOtp` and `verifyOtp` — the two points new-user creation could occur — as defense-in-depth. Has one bypass: `isAdminDomainEmail(email, adminByDomain)` lets an email on a configured admin domain through even when signup is gated (the admin bootstrap path). **If you ever touch one call site, check the other** — a fix applied to only `requestOtp` or only `verifyOtp` reopens the gate at the other entry point.

> **There is now a third gate, outside this package.** The Keycloak login path doesn't go through these plugins at all: `apps/api/src/services/auth/provisioning.ts` enforces the same self-signup and channel rules when it mirrors a Keycloak subject into the local `user` table. It is inert while `AUTH_PROVIDER=betterauth`, but a change to the *policy* (as opposed to this implementation of it) has to be made in both places for as long as both providers exist.

> **Under `AUTH_PROVIDER=keycloak` nothing in this package runs.** `app.ts` does not register the `/api/auth/*` mount at all, so `checkUser` / `requestOtp` / `verifyOtp` are unreachable — which matters because `verifyOtp` creates users, and one created that way would have no Keycloak identity and so could never log in. The `isAdminDomainEmail` bypass in `assertSelfSignupAllowed` has **no** Keycloak counterpart on purpose: admin creation there is an explicit operator action (`pnpm keycloak:create:admin`) rather than an email-domain rule. See `docs/superpowers/plans/2026-07-31-replace-better-auth-with-keycloak.md`.
