# Self-signup gate & configurable login channels — design

**Date:** 2026-07-08
**Issue:** [Blue-Dots-Economy/signals-dpg#105](https://github.com/Blue-Dots-Economy/signals-dpg/issues/105) — *Self sign-up gated off; participants onboarded only via Aggregator (UI/voice bot)*
**Labels:** area:api, area:security, area:ui

## Summary

Two independent, instance-level (env) configuration flags for the authentication layer:

1. **Self-signup gate** — block self-service account creation on the public OTP flow. When gated, new participants are onboarded **only** via the admin/aggregator path (`POST /api/v1/admin/participant`) or the voice-bot service principal. Default: **gated**.
2. **Configurable login channels** — restrict which identifiers the OTP flow accepts: email only, phone only, or both. Default: **both**.

Both flags are enforced **authoritatively in the `unified_otp` auth plugin** (server-side, un-bypassable by direct API callers) and mirrored in the UI purely for UX via a small public config endpoint.

## Background — current behaviour

The UI login flow is a *unified* OTP flow (login doubles as signup). There is no separate signup page.

- `POST /api/auth/unified-otp/request` — looks up the user, sends an OTP (SMS via phone, email via NS).
- `POST /api/auth/unified-otp/verify` — validates the OTP, then **creates the user if none exists** (`isNewUser` branch → `ctx.context.adapter.create({ model: 'user', … })`), with `onboardedByOrgId = null`, and issues a session.

The **allowed** onboarding path is unrelated code: `POST /api/v1/admin/participant` → `authInstance.api.signUpEmail(...)` in `apps/api/src/routes/v1/admin/participant.ts`, which sets `onboardedByOrgId = acting_org`. Because it uses a different better-auth endpoint (`signUpEmail`), gating the OTP-verify path does **not** affect it.

Both flags are currently absent — self-signup always works and both channels are always accepted.

## Design decisions (agreed)

| # | Decision | Choice |
|---|----------|--------|
| Config source | Where the flags live | **Instance env vars** (auth plugin is boot-instantiated and its OTP endpoints carry no per-request network context; an instance serves one network in practice, so instance ≈ network) |
| Gate scope | What "gated" blocks | **New-user creation only.** Already-onboarded users still log in via OTP; admin/aggregator onboarding unaffected |
| UI behaviour | Gated UX | UI **blocks + shows "contact your aggregator" message** for an unknown identifier; API hard-blocks as defense-in-depth |
| Login channels | Model + default | Config **lists** allowed channels (`email`, `phone`, or `email,phone`); default = **both**. No separate `both` literal |
| Admin bootstrap | Interaction with gate | Emails whose domain ∈ `ADMIN_DOMAINS` are **exempt** from the gate (admins are not participants). Applied uniformly at `requestOtp` and `verifyOtp` |
| Enforcement point | Where the gate runs | Authoritative block in `verifyOtp` immediately **before** `adapter.create`; early-exit block in `requestOtp` to avoid sending a pointless OTP |

## Configuration (env)

Added to the Auth secrets schema in `packages/config/src/secrets.ts`, mirroring the existing `AUTH_MIDDLEWARE_ENABLED` / `CREATE_TEST_OTP` string-transform pattern.

### `SELF_SIGNUP_MODE`
- Type: `z.enum(['gated', 'allowed']).default('gated')`
- **Default `gated`.** ⚠️ This flips today's behaviour. Existing deployments that rely on self-signup **must** set `SELF_SIGNUP_MODE=allowed`. Documented in `.env.example` and `SETUP.md`.
- Exposed by `apps/api/src/config.ts` as a derived boolean `allowSelfSignup = SELF_SIGNUP_MODE === 'allowed'`.

### `LOGIN_CHANNELS`
- Type: `z.string().default('email,phone')`
- Parsed by a new helper `parseLoginChannels(input): ('email' | 'phone')[]` in `packages/config` (alongside `parseServedDomains`):
  - Splits on `,`, trims, lowercases.
  - Validates every entry ∈ `{'email', 'phone'}`.
  - Rejects empty / unknown entries with a clear startup error (fail fast, like `parseServedDomains`).
  - Returns a de-duplicated, non-empty array.
- `email` → email only; `phone` → phone only; `email,phone` → both.

### turbo passthrough
Both `SELF_SIGNUP_MODE` and `LOGIN_CHANNELS` are added to `turbo.json` `globalPassThroughEnv` so they reach filtered tasks (`dev:api`) — the standard "works locally, fails in `pnpm dev:api`" gotcha.

## Wiring into the auth plugin

```
env (secrets.ts)
  → apps/api/src/config.ts   (auth.allowSelfSignup, auth.loginChannels)
  → apps/api/src/routes/auth/create_auth.ts   (pass to createAuth)
  → packages/auth/src/types.d.ts   (AuthRuntimeConfig gains fields)
  → packages/auth/src/config.ts   (createAuth forwards into unifiedOtp({...}))
  → packages/auth/plugins/unified_otp.ts   (unifiedOtpOptions gains fields; enforcement)
```

New `AuthRuntimeConfig` fields:
- `allowSelfSignup: boolean`
- `loginChannels: ('email' | 'phone')[]`

New `unifiedOtpOptions` fields (same two).

Both values are captured at boot; they are **not** request parameters, so a caller cannot override them via payload.

## Enforcement (`packages/auth/plugins/unified_otp.ts`)

### Login-channel guard
A small helper rejects a request whose identifier channel is not in `loginChannels`:
- If a `phoneNumber` is supplied but `'phone' ∉ loginChannels` → reject.
- If an `email` is supplied but `'email' ∉ loginChannels` → reject.
- Error: `APIError('BAD_REQUEST', { message: 'Phone/Email login is not enabled on this instance.', code: 'LOGIN_CHANNEL_DISABLED' })`.
- Applied in `requestOtp` (primary — before any OTP is sent) and defensively in `checkUser` and `verifyOtp`.

### Self-signup gate
Authoritative block in `verifyOtp`, inserted **before** `adapter.create`:

```js
if (!user) {
  // Self-signup gate — authoritative, runs regardless of caller (UI, curl, bot).
  const isAdminBootstrap =
    createAdmin && !!email && adminByDomain?.includes(email.split('@')[1] ?? '');

  if (!allowSelfSignup && !isAdminBootstrap) {
    throw new APIError('FORBIDDEN', {
      message: 'Self sign-up is disabled on this instance. Contact your aggregator to get onboarded.',
      code: 'SELF_SIGNUP_DISABLED',
    });
  }

  isNewUser = true;
  user = await ctx.context.adapter.create({ model: 'user', data: { /* … */ } });
}
```

Behaviour for a direct API call with a valid OTP for an unknown identifier on a gated instance:
1. OTP validated and consumed.
2. User lookup returns nothing → enters `if (!user)`.
3. `allowSelfSignup === false` and not admin-bootstrap → `throw FORBIDDEN` (`SELF_SIGNUP_DISABLED`).
4. Handler exits **before** `adapter.create` → **no user row created, no session issued**. Caller receives `403`.

Early-exit block in `requestOtp`: if `!allowSelfSignup` and the identifier resolves to no existing user (and not admin-bootstrap) → reject with `SELF_SIGNUP_DISABLED` **before** sending an OTP. This is **defense-in-depth for direct API callers that skip `check-user`** (the UI never reaches here — see below); it also prevents SMS/email-pumping abuse (a direct caller triggering OTP sends to arbitrary unknown numbers). The verify-time block remains the un-bypassable authority.

### Enforcement layering
- **UI happy path:** the gate is `check-user`. When it returns `userExists: false` on a gated instance, the UI stops immediately and shows the "contact your aggregator" message — it does **not** call `/request` or `/verify`, so **no OTP is generated or sent**.
- **Server (direct callers only):** the `requestOtp` and `verifyOtp` blocks exist purely for callers that bypass `check-user` (curl, bots, attackers). `verifyOtp` is authoritative (no account can be created without passing it); `requestOtp` additionally blocks OTP-send abuse.

Existing users are never affected: when `user` is found, the `if (!user)` branch is skipped and login proceeds as today.

### Admin-domain bootstrap exemption
When the email's domain ∈ `adminByDomain` (from `ADMIN_DOMAINS`), user creation is allowed even while gated — otherwise a fresh gated instance could not bootstrap its first admin. Applied uniformly in `requestOtp` and `verifyOtp` (independent of the `createAdmin` flag, which `requestOtp` does not carry). These are trusted internal domains, not participant self-signup.

## Public config endpoint (UI support)

New unauthenticated route: `GET /api/v1/auth/config`

```json
{ "selfSignupAllowed": false, "loginChannels": ["email", "phone"] }
```

Sourced directly from server env (`apps/api/src/config.ts`). Server env stays the **single source of truth** — the flags are not duplicated into the UI build. The UI already boot-fetches network config, so this fits the existing pattern.

## UI (`apps/ui`)

Affected: `src/lib/auth-api.ts`, `src/contexts/auth-context.tsx`, `src/pages/auth/login-page.tsx`, `src/pages/auth/otp-page.tsx`.

- `fetchAuthConfig()` added to `auth-api.ts`; called on login load.
- **Channels:** render only the allowed identifier input(s) per `loginChannels`. Both → current behaviour (email + phone).
- **Gated flow (primary gate for the UI):** on identifier submit, the UI calls `check-user`. If `userExists === false` **and** `selfSignupAllowed === false` → show "**Contact your aggregator to get onboarded**" and stop. It does **not** call `/request` or `/verify`, so **no OTP is generated or sent** — the block happens on the first API call, before any OTP work.
- Gracefully surface API error codes `SELF_SIGNUP_DISABLED` and `LOGIN_CHANNEL_DISABLED` (e.g. if the config is fetched stale and the API rejects).

The UI is UX only; it never relaxes the server gate.

## Error handling

Machine-readable codes returned by the auth plugin:
- `SELF_SIGNUP_DISABLED` — HTTP `403`. New-user creation attempted while gated (from `requestOtp` early-exit and `verifyOtp`).
- `LOGIN_CHANNEL_DISABLED` — HTTP `400`. A disallowed channel was used.

Routes/handlers never throw raw errors past the boundary.

## Testing

**Config (`packages/config`)**
- `parseLoginChannels`: default `both`; single channel; multi; whitespace; duplicates; invalid entry → error; empty → error.
- `SELF_SIGNUP_MODE`: default is `gated`; parses `allowed`.

**`unified_otp` unit**
- Gated + unknown identifier → rejected at `requestOtp` (no OTP sent) and at `verifyOtp` (no user created), `SELF_SIGNUP_DISABLED`.
- Gated + existing user → login succeeds.
- Allowed + unknown identifier → user created (today's behaviour).
- Admin-domain bootstrap (`createAdmin` + `adminByDomain`) → allowed even when gated.
- Channel guard: `LOGIN_CHANNELS=email` + phone identifier → `LOGIN_CHANNEL_DISABLED` before OTP; and vice-versa; `both` accepts either.

**API integration**
- `POST /api/v1/admin/participant` onboarding still creates users when `SELF_SIGNUP_MODE=gated` (regression guard for the allowed path).
- `GET /api/v1/auth/config` returns the configured values.

**UI**
- Renders correct identifier input(s) per `loginChannels`.
- Unknown identifier + gated → shows the "contact your aggregator" message and does not proceed.

## Out of scope

- Per-network (as opposed to per-instance) configuration — deferred; instance ≈ network today, and the OTP endpoints carry no network context.
- Migrating or backfilling existing self-registered users (`onboardedByOrgId = null`).
- Changes to the admin/aggregator/voice onboarding endpoints beyond confirming they remain functional.

## Files touched (anticipated)

- `packages/config/src/secrets.ts` — `SELF_SIGNUP_MODE`, `LOGIN_CHANNELS`.
- `packages/config/src/network_runtime.ts` (or sibling) — `parseLoginChannels`.
- `turbo.json` — `globalPassThroughEnv`.
- `apps/api/src/config.ts` — expose `allowSelfSignup`, `loginChannels`.
- `apps/api/src/routes/auth/create_auth.ts` — pass through.
- `packages/auth/src/types.d.ts` — `AuthRuntimeConfig` fields.
- `packages/auth/src/config.ts` — forward into `unifiedOtp`.
- `packages/auth/plugins/unified_otp.ts` — options + enforcement (channel guard, self-signup gate).
- `apps/api/src/routes/v1/auth/` (new) — `GET /api/v1/auth/config`.
- `apps/ui/src/lib/auth-api.ts`, `src/contexts/auth-context.tsx`, `src/pages/auth/login-page.tsx`, `src/pages/auth/otp-page.tsx`.
- `.env.example`, `SETUP.md` — document both flags and the gated default.
