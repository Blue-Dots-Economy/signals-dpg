# Partner-portal SSO (NCS)

**Written:** 2026-09-24. Design: `docs/superpowers/specs/2026-09-24-external-idp-bridge-ncs-sso-design.md`.

A user already logged in to a partner portal (today: the National Career
Service, NCS) clicks a Bluedots link and lands in Bluedots **logged in**, with a
draft profile pre-filled from their partner details. No OTP, no login screen.

## How it works, in one paragraph

The partner redirects the browser to `GET /api/v1/auth/sso/login` with a signed
link. The Signals API checks the link completely (signature, 5-minute expiry,
single use, and the partner's own `validate-token` API), decides which Bluedots
account this person is (by verified mobile number), and hands the browser to
Keycloak with `kc_idp_hint=signals-sso`. That identity provider **is the Signals
API** (`/api/v1/auth/sso/oidc/*`), so Keycloak immediately gets back a signed
id_token for the verified user, creates or links its own user, and finishes an
ordinary Keycloak login into `/session/callback`. The callback creates the local
user (even on a gated instance) and the draft profile.

## What NCS gets from us

- Redirect URL, per instance: `https://<signals-api-host>/api/v1/auth/sso/login`
  (the URL names no partner — the instance's `SSO_PROVIDERS` decides). Use the
  `API_BASE_URL` host. A link that reaches the API under another hostname is
  redirected there first (the one-time `sso_h` cookie must be on the host
  Keycloak sends the browser back to), so it still works, at one extra hop.
- Platform name and description.

## Signals API configuration

All in `packages/config/src/secrets.ts` (and passed through by `turbo.json`'s
`SSO_*`). SSO is off — every `/sso` route answers 404 — until `SSO_PROVIDERS`
is set, and it requires `AUTH_PROVIDER=keycloak`. Boot fails if an enabled
provider is missing a secret.

| Variable | Value |
|---|---|
| `SSO_PROVIDERS` | `ncs` |
| `SSO_OIDC_SIGNING_KEY` | EC P-256 private key, PKCS#8 PEM. **Whoever holds it can log in as any SSO user** — secret store only. `openssl ecparam -name prime256v1 -genkey -noout \| openssl pkcs8 -topk8 -nocrypt` |
| `SSO_OIDC_CLIENT_ID` | `signals-sso` (default) |
| `SSO_OIDC_CLIENT_SECRET` | ≥ 32 chars; must equal the Keycloak identity provider's client secret. `openssl rand -hex 32` |
| `SSO_NCS_BASE_URL` | staging `https://ncsapi.centralindia.cloudapp.azure.com`, prod `https://betacloud.ncs.gov.in` |
| `SSO_NCS_CLIENT_ID` / `SSO_NCS_CLIENT_SECRET` | issued by NCS |
| `SSO_NCS_TIMEOUT_MS` | default `5000` |
| `SSO_NCS_MAPPING` | JSON, below |

```json
{
  "network": "blue_dot",
  "item_type": "profile_1.0",
  "role_to_domain": { "JOBSEEKER": "seeker" },
  "fields": { "fullName": "name", "mobileNumber": "phone" },
  "feature_routes": { "placement-prep": "/" },
  "app_origin": "https://<ui-host>"
}
```

- `fields` maps NCS `data.*` fields onto the profile schema. Map only fields the
  schema declares — the seeker schema is `additionalProperties: false`, so an
  undeclared target makes the draft-profile create fail (logged, login still
  succeeds).
- `feature_routes` maps NCS `featureKey` to a UI path; unknown keys and
  off-origin values land on `/`.
- `app_origin` must also be in the CORS allowlist.

UI runtime config (`/config.js`): `VITE_SSO_PARTNER_URL` and
`VITE_SSO_PARTNER_NAME` give the error page its "Back to NCS" button.

## Keycloak

All SSO realm config lives in **`infra/keycloak/init/apply-sso-idp.sh`** —
`realms/bluedots-realm.json` is deliberately unchanged (it is shared with
aggregator-dpg). Run the script after every Keycloak boot, next to
`apply-user-profile.sh`; it is idempotent and re-syncs URLs and the secret.
It creates the `signals-sso` identity provider (token + JWKS URLs on the
internal API base), its five mappers, the no-screens first-login flow, and puts
`identity-provider-redirector` first in the browser flow.

| Variable (init script) | Meaning |
|---|---|
| `API_BASE_URL` | browser-facing API base — the provider's issuer and authorize URL |
| `SSO_API_INTERNAL_BASE_URL` | where Keycloak itself reaches the API for `/token` and `/jwks` (cluster-internal) |
| `SSO_OIDC_CLIENT_SECRET` | same value as the API's |

**Ingress:** `/api/v1/auth/sso/oidc/token` is only ever called by Keycloak.
Block it from the public internet and let Keycloak use the internal URL.

**Logs:** the API's request log drops the query string of every
`/api/v1/auth/*` route (`utils/log_redaction.ts`) — the partner token, OIDC
`code` and `state` never reach it. An ingress or proxy that writes its own
access log must do the same for `/api/v1/auth/sso/login`.

**Signing key:** parsed at boot; a malformed `SSO_OIDC_SIGNING_KEY` (wrong
curve, broken PEM) stops the API from starting. A PEM whose line breaks arrive
as literal `\n` is accepted.

**Rate limit:** `/sso/login` allows 120 requests per minute per IP (partner
users often share an IP). Over it, the browser lands on the error page with
`provider-unavailable`, not a JSON 429.

## Failure reasons

Every refusal lands on the UI's `/auth/sso/error?reason=…` and is logged with
the same code (never the token):

| reason | Meaning |
|---|---|
| `link-invalid` | malformed, bad signature, or NCS said no |
| `link-expired` | past the 5-minute lifetime |
| `link-reused` | this exact link was already used. A link is only marked used once account linking succeeded, so an NCS or Keycloak outage never burns it |
| `provider-unavailable` | NCS (or Keycloak Admin) down / slow, or rate-limited — retryable with the same link |
| `account-inactive` | NCS account not `ACTIVE` |
| `phone-unverified` | NCS hasn't verified the number — no account is created on it or linked to it |
| `link-conflict` | the number belongs to another NCS user, or to several accounts |

**Account linking order:** an account already linked to this NCS user (the
Keycloak `signals-sso` link) always wins, so a returning user whose NCS number
changed keeps their account. Only then is the phone number looked up.
| `session-expired` | the login was interrupted, or Keycloak logged in the wrong account |

## Testing locally (what was verified on 2026-09-24)

A throwaway setup that leaves the regular dev stack alone:

1. Keycloak on `:8089` importing the realm (render with `API_BASE_URL=http://localhost:2799`,
   `SSO_API_INTERNAL_BASE_URL=http://host.docker.internal:2799`), then
   `apply-user-profile.sh` and `apply-sso-idp.sh` with `KC_URL=http://localhost:8089`.
2. A stub for NCS `validate-token` (checks the HMAC, answers from fixtures) and a
   script that builds NCS-style links (HS256 JWT + CryptoJS `sig`) with the same secret.
3. The API on `:2799` (`AUTH_PROVIDER=keycloak`, `SELF_SIGNUP_MODE=gated`, SSO vars
   pointing at the stub) and the UI on `:5174` with `VITE_API_URL=http://localhost:2799`.

Verified end to end: new user (Keycloak user `+91…` with phone attributes, the
`signals_participant` role and the `signals-sso` link; local user; draft profile
with name + phone; UI lands on it), returning user (same account, no second
profile), linking an existing account on a verified number, `phone-unverified`,
`link-conflict`, replay, expired link (NCS never called), tampered `sig`,
inactive account, and a shared browser (the previous user's session and its
Keycloak session are ended). New seeker accounts are asked for a birth year on
first landing — the existing U18 gate, since NCS sends no DOB.
