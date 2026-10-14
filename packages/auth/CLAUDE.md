# CLAUDE.md — packages/auth

**This package no longer has anything to do with authentication.** #517 retired
better-auth: `src/config.ts` (the `betterAuth(...)` instance), `plugins/`
(`unified_otp`, `auth_guards`, `otp_delivery`) and `utils/` (session cookie
helpers) are all gone, along with the `better-auth` / `@better-auth/api-key`
dependencies. Keycloak is the only identity provider.

The name is kept only because renaming a workspace package touches every
importer. What actually lives here is **PII crypto**:

- `src/pii_crypto.ts` — envelope encrypt/decrypt for the private item blob.
- `src/pii_key.ts` — derives the key material from `SIGNALS_PII_KEY`.

Both are re-exported from `src/index.ts`, and both are load-bearing well beyond
auth: `item_service.ts` encrypts the private blob through them, and
`services/geocoding/jitter.ts` HMACs the same key to place a private location
deterministically inside its jitter annulus (see `.claude/rules/database-conventions.md`).
Deleting this package because it "was the auth package" would silently take out
item encryption and location jitter — neither of which has a compile-time link
to identity.

## Where the auth material went

| Was here | Now |
|---|---|
| `createAuth()` / `betterAuth(...)` | nothing — Keycloak is the provider |
| `verifyApiKey` (better-auth plugin) | `apps/api/plugins/auth/verify_api_key.ts`, a native in-process verifier over the same `apikey` table and hash |
| `unified_otp` (OTP login) | Keycloak's own login flow; the API's BFF cookie exchange is `apps/api/src/routes/v1/auth/session.ts` |
| `assertSelfSignupAllowed` / `assertChannelAllowed` | `apps/api/src/services/auth/provisioning.ts`, which enforces the same `SELF_SIGNUP_MODE` / `LOGIN_CHANNELS` policy when mirroring a Keycloak subject |
| session cookie helpers | `apps/api/plugins/auth/resolve_browser_session.ts` |

The auth model as a whole is documented in `.claude/rules/auth-model.md`.

## The `apikey` table outlived the library, on purpose

`verify_api_key.ts` reads the same `apikey` table better-auth used, with the
same `base64url(sha256(key))` hash. That is not leftover coupling — the table is
a **cross-repo contract**: signals-search validates against it with its own SQL
(#516), and the automation's `provision_service_users.sql` seeds it with a raw
Postgres `digest()` that never loaded better-auth. Dropping the table is #517's
remaining half and is blocked on #516.

Two columns there look like library bookkeeping and are not:

- **`remaining`** — signals-search filters on `(remaining IS NULL OR remaining > 0)`.
  Nothing decrements it any more (neither side writes, to avoid racing the
  owner), so it is static — but it still gates auth in another repo.
- **`rate_limit_enabled`** — seeded `false` for every service key, which is why
  better-auth's 10 000/hr ceiling was **already inert** and was not ported.
