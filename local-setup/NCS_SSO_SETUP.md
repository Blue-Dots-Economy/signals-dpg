# Enable NCS SSO on a local Signals

For a team that **already runs Signals locally** and wants NCS single sign-on
working on it. Background and production notes: `docs/operations/partner-sso.md`.

What you get: a user logged in on NCS clicks the Bluedots link, lands on the
local Bluedots UI **logged in**, with a draft profile pre-filled from NCS.

```
NCS (staging) ──redirect──▶ http://localhost:2742/api/v1/auth/sso/login
                               │ checks the link, calls NCS validate-token
                               ▼
                           Keycloak (:8080) ◀──▶ Signals /api/v1/auth/sso/oidc/*
                               │
                               ▼
                           http://localhost:5173  (logged in, My Profiles)
```

## 0. Prerequisites

- This branch: `git fetch && git checkout feat/external-idp-bridge` (or `main`
  once merged), then rebuild / restart as you normally do.
- **Keycloak must be the login provider.** SSO does not work with
  `AUTH_PROVIDER=betterauth`. If you run better-auth today, step 2 switches you.
- From NCS: a **Client ID** and **Client Secret** (staging).
- `openssl`, and for the manual Keycloak step `curl` + `jq`.

## 1. Generate the two Signals secrets

```bash
# shared by the Signals API and Keycloak — must be identical in both
openssl rand -hex 32

# id_token signing key (EC P-256). Keep it secret.
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt
```

## 2. Add the settings

Put these in the `.env` your Signals already reads — `local-setup/.env` for the
Docker stack, or the repo-root `.env` if you run the API with `pnpm dev:api`.

```bash
# Keycloak as the login provider
AUTH_PROVIDER=keycloak

# ── NCS SSO ───────────────────────────────────────────────────────────
SSO_PROVIDERS=ncs
SSO_NCS_BASE_URL=https://ncsapi.centralindia.cloudapp.azure.com   # NCS staging
SSO_NCS_CLIENT_ID=<Client ID from NCS>
SSO_NCS_CLIENT_SECRET=<Client Secret from NCS>
SSO_OIDC_CLIENT_SECRET=<output of `openssl rand -hex 32`>
# one line, newlines written as \n
SSO_OIDC_SIGNING_KEY="-----BEGIN PRIVATE KEY-----\nMIGH...\n-----END PRIVATE KEY-----"
SSO_NCS_MAPPING={"network":"blue_dot","role_to_domain":{"JOBSEEKER":"seeker"},"fields":{"fullName":"name","mobileNumber":"phone"},"feature_routes":{"placement-prep":"/"},"app_origin":"http://localhost:5173"}

# optional — the error page's "Back to NCS" button. Read by the UI dev server
# (`pnpm dev:ui`); the Docker UI image takes it from its runtime /config.js.
VITE_SSO_PARTNER_URL=https://<ncs-staging-portal-url>
VITE_SSO_PARTNER_NAME=NCS
```

Rarely needed (defaults shown): `SSO_OIDC_CLIENT_ID=signals-sso`,
`SSO_OIDC_IDP_ALIAS=signals-sso`, `SSO_NCS_TIMEOUT_MS=5000`.

`SSO_NCS_MAPPING`, in words:

| Key | Meaning |
|---|---|
| `network` | network the draft profile is created in |
| `role_to_domain` | NCS role → Bluedots domain; a role not listed gets no draft profile |
| `fields` | NCS field → profile field (only fields the profile schema declares) |
| `feature_routes` | NCS `featureKey` → Bluedots page; unknown keys open `/` |
| `app_origin` | the Bluedots UI address users land on |

The API refuses to start if SSO is on and a required value is missing or
invalid — the error names the variable.

## 3. Start Keycloak and apply the SSO configuration

### Docker stack (`local-setup/`)

```bash
cd local-setup
docker compose --profile keycloak up -d --build
```

The `keycloak-init` step runs `apply-user-profile.sh` and then
`infra/keycloak/init/apply-sso-idp.sh` automatically. Check it:

```bash
docker compose logs keycloak-init | grep kc-sso
# … [kc-sso] signals-sso identity provider ready.
```

### API on the host (`pnpm dev:api`)

Start Keycloak (`docker compose --profile keycloak up -d keycloak keycloak-init`
from `local-setup/`), or apply the script to your own Keycloak:

```bash
KC_URL=http://localhost:8080 \
API_BASE_URL=http://localhost:2742 \
SSO_API_INTERNAL_BASE_URL=http://host.docker.internal:2742 \
SSO_OIDC_CLIENT_SECRET=<same value as in .env> \
sh infra/keycloak/init/apply-sso-idp.sh
```

`SSO_API_INTERNAL_BASE_URL` is where **Keycloak** reaches the API for `/token`
and `/jwks`: `host.docker.internal:2742` when Keycloak is in Docker and the API
on the host (or published on the host), `http://localhost:2742` when both run on
the host. The script is idempotent — re-run it after changing the secret.

Then restart the API so it picks up the new `.env`.

## 4. Check the API side

```bash
curl -s localhost:2742/api/v1/auth/config | jq .authProvider      # "keycloak"
curl -s -o /dev/null -w '%{http_code}\n' localhost:2742/api/v1/auth/sso/oidc/jwks   # 200
```

A `404` on `/jwks` means SSO is off (`SSO_PROVIDERS` not set, or
`AUTH_PROVIDER` is not `keycloak`).

## 5. Register the redirect URL with NCS

```
http://localhost:2742/api/v1/auth/sso/login
```

NCS appends `?userName=…&sig=…&expiry=…&featureKey=…`. The browser makes this
redirect, so `localhost` works for local testing. The API calls NCS
`validate-token` itself, so the machine needs outbound internet access.

## 6. Test

1. Log in to NCS staging and open the Bluedots link.
2. Expected: a few quick redirects, then `http://localhost:5173` logged in. A
   **new** user sees the consent screen, then My Profiles with a draft profile
   (name + mobile from NCS). A returning user goes straight in.
3. Re-open the same link → error page, *already used*. Links also expire
   5 minutes after NCS issues them.

No NCS access yet? `local-setup/ncs-demo/` is a stand-in NCS portal + API
(`SSO_NCS_BASE_URL=http://localhost:4555`, same Client ID/Secret on both sides).

**Under-18 step:** if the seeker domain in your `network.json` has
`"guardian_consent_required": true`, new seekers are asked for a birth year
(NCS sends no date of birth). Set it to `false` in your local `network.json`
if you are not testing that flow.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/sso/login` or `/jwks` returns 404 | SSO off: set `SSO_PROVIDERS=ncs` and `AUTH_PROVIDER=keycloak`, restart the API |
| API won't start, names an `SSO_*` variable | that value is missing or malformed (the signing key must be a P-256 PKCS#8 PEM) |
| Error page `link-invalid` | Client Secret differs from NCS's, or the link was tampered with; the API log says which check failed |
| Error page `link-expired` | link older than 5 minutes, or the machine's clock is off |
| Error page `provider-unavailable` | NCS `validate-token` unreachable or slow; or the API has no `KEYCLOAK_API_CLIENT_SECRET` for the Keycloak Admin lookup |
| Error page `phone-unverified` | NCS reports the mobile as not verified — Bluedots never creates or links an account on an unverified number |
| Error page `link-conflict` | that mobile belongs to a different NCS user, or to several Bluedots accounts |
| Keycloak page "Unexpected error when authenticating with identity provider" | Keycloak cannot reach `SSO_API_INTERNAL_BASE_URL`, or its `SSO_OIDC_CLIENT_SECRET` differs from the API's — re-run `apply-sso-idp.sh` with the right values |
| Lands on the normal OTP login screen | the `identity-provider-redirector` step is missing — re-run `apply-sso-idp.sh` |

Turning SSO off again: remove `SSO_PROVIDERS` (or set it empty) and restart the
API. The Keycloak configuration can stay; it does nothing without SSO requests.
