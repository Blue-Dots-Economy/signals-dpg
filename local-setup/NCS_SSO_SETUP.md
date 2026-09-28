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
`SSO_OIDC_IDP_ALIAS=signals-sso`, `SSO_NCS_TIMEOUT_MS=5000`,
`SSO_NCS_SINGLE_USE_LINKS=false` (a link can be reused until it expires; set
`true` so each link logs in once).

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

`http`, not `https` — the local API serves plain HTTP. NCS appends
`?token=<JWT>&clientId=<our client id>` (optionally `&featureKey=<key>`). The
browser makes this redirect, so `localhost` works for local testing. The API
calls NCS `validate-token` itself, so the machine needs outbound internet
access to the NCS API host.

The token is opaque to us (NCS signs it with its own key); NCS
`validate-token` decides whether it is genuine. It lives as long as NCS's
`exp` says (1 day in production). By default a link can be opened again until
then; set `SSO_NCS_SINGLE_USE_LINKS=true` to make each link log in once.

## 6. Test

1. Log in to NCS staging and open the Bluedots link.
2. Expected: a few quick redirects, then `http://localhost:5173` logged in. A
   **new** user sees the consent screen, then My Profiles with a draft profile
   (name + mobile from NCS). A returning user goes straight in.
3. Re-open the same link → logged in again (default). With
   `SSO_NCS_SINGLE_USE_LINKS=true` → error page, *already used*.

**Under-18 step:** if the seeker domain in your `network.json` has
`"guardian_consent_required": true`, new seekers are asked for a birth year
(NCS sends no date of birth). Set it to `false` in your local `network.json`
if you are not testing that flow.

**Checking a token without Bluedots.** To see what NCS itself says about a
token, call `validate-token` directly. The `hmac` is HMAC-SHA256 of the token,
keyed with the Client Secret, as lowercase hex:

```bash
TOKEN='<token from the link>'; SECRET='<client secret>'
HMAC=$(printf '%s' "$TOKEN" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')
curl -sS -X POST https://ncsapi.centralindia.cloudapp.azure.com/api/integration/validate-token \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"hmac\":\"$HMAC\",\"clientId\":\"<client id>\"}"
```

`"status":"SUCCESS"` with a `data.userId` means the token is good and any
failure is on the Bluedots side. `User not found with ID …` means the token
was issued by a different NCS environment than the one you are validating
against.

## 7. Windows checklist

Everything above works on Windows with Docker Desktop. These are the things
that actually trip people up:

1. **Line endings.** The Keycloak init scripts run in a Linux container. The
   repo pins `*.sh` to LF (`.gitattributes`), but a clone made before that, or
   with an editor that rewrites line endings, fails with `sh: \r: not found`
   in `docker compose logs keycloak-init`. Fix:
   `git config --global core.autocrlf input`, then
   `git rm --cached -r . ; git reset --hard`. Check with
   `git ls-files --eol infra/keycloak/init/` (want `w/lf`).
2. **Docker Desktop** on the WSL2 backend, running, with ~6 GB of memory
   (Settings → Resources).
3. **Ports free:** 2742 (API), 5173 (UI — fixed, it is in the API's CORS
   allow-list), 8080 (Keycloak), 5432 (Postgres), 5555 (Redis). A local
   Postgres or another app often holds 5432/8080:
   `netstat -ano | findstr ":8080"`.
4. **No `openssl`?** Generate the two secrets through Docker (PowerShell):
   ```powershell
   docker run --rm alpine/openssl rand -hex 32
   docker run --rm --entrypoint sh alpine/openssl -c "openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt | awk '{printf \"%s\\\\n\", \$0}'"
   ```
   The second prints the signing key already on one line with `\n` — paste it
   between the double quotes of `SSO_OIDC_SIGNING_KEY="…"`.
5. **`.env` in a plain editor.** Save as UTF-8 **without BOM** (a BOM hides the
   first variable). Keep `SSO_OIDC_SIGNING_KEY` and `SSO_NCS_MAPPING` on one
   line each — Notepad word-wrap is fine, a real line break is not.
6. **`curl` in PowerShell is an alias** for `Invoke-WebRequest`; use
   `curl.exe`, or `Invoke-RestMethod`.
7. **Browser forces `https://localhost`.** If some other local app on
   `https://localhost` sent an HSTS header, Chrome/Edge upgrade every
   `http://localhost:*` URL, and the link fails with "This site can't provide
   a secure connection". Clear it: `chrome://net-internals/#hsts` (or
   `edge://net-internals/#hsts`) → *Delete domain security policies* →
   `localhost`.
8. **Proxy / antivirus.** The API container must reach the NCS API host on
   443. Test from Docker:
   `docker run --rm curlimages/curl -sS -o /dev/null -w "%{http_code}" https://ncsapi.centralindia.cloudapp.azure.com`.
9. **Restart after every `.env` change:** `docker compose up -d` from
   `local-setup/`. A running container keeps the old values.

## Troubleshooting

Every refusal lands on `http://localhost:5173/auth/sso/error?reason=…`. The
reason is deliberately coarse; the API log line says exactly which check
failed:

```bash
docker compose logs api | grep "sso:"          # PowerShell: | findstr "sso:"
```

Look at `msg` and `detail`:

- `"msg":"sso: partner link refused"` — the link or NCS refused it.
- `"msg":"sso: account link refused"` — NCS **accepted** the token; the failure
  is in the Bluedots/Keycloak account lookup.

### By log `detail`

| `detail` | Cause / fix |
|---|---|
| `missing or malformed token parameter` | the URL has no `token=` (or it is empty / repeated). Check the redirect URL NCS builds |
| `clientId does not match` | `clientId=` in the link differs from `SSO_NCS_CLIENT_ID` (watch for a stray trailing `"` / `%22`) |
| `token is not a JWT` | the token was mangled — copied with a line break, space or trailing `&`. Paste the link in one piece |
| `JWT has no exp or iat` / `JWT issued in the future` | not an NCS SSO token, or this machine's clock is off |
| `NCS status FAILURE` | NCS rejected it: wrong `SSO_NCS_CLIENT_SECRET`/`SSO_NCS_CLIENT_ID` (HMAC mismatch), or the token is from another NCS environment. Check with the direct `validate-token` call in §6 |
| `NCS returned 5xx` | NCS is down — retry later |
| `This operation was aborted` / `fetch failed` (partner link) | NCS API not reachable from the container: wrong `SSO_NCS_BASE_URL`, DNS, proxy or firewall (Windows checklist 8) |
| `NCS returned a non-JSON body` | `SSO_NCS_BASE_URL` points at a website, not the API. Use the bare API host, no `/api/...` path |
| `NCS returned an unexpected body` / `NCS SUCCESS body has no usable user` | NCS's response shape changed — send the raw response to the Bluedots team |
| `NCS call refused (open)` | circuit breaker open after 5 failures in a row; wait 30 s. The real cause is in the earlier log lines |
| `NCS returned no usable mobile number` | the NCS account has no valid Indian mobile |
| `Keycloak Admin-REST client is not configured` (account link) | the API has no Keycloak admin client credentials (`KEYCLOAK_API_CLIENT_SECRET`) |
| `fetch failed` / TLS error (account link) | the API cannot reach Keycloak. If Keycloak is behind HTTPS with a self-signed certificate, set `KEYCLOAK_INTERNAL_BASE_URL=http://keycloak:8080` so the API talks to it over plain HTTP. Do **not** set `NODE_TLS_REJECT_UNAUTHORIZED=0` — it also disables certificate checks on the NCS call |

### By symptom

| Symptom | Cause / fix |
|---|---|
| `{"error":"NOT_ENABLED","message":"SSO is not enabled"}` or `/jwks` 404 | SSO off: set `SSO_PROVIDERS=ncs` and `AUTH_PROVIDER=keycloak`, then recreate the API container |
| API won't start, names an `SSO_*` variable | that value is missing or malformed (the signing key must be a P-256 PKCS#8 PEM) |
| "This site can't provide a secure connection" | the URL is `https://localhost:2742` — use `http`, or clear HSTS (Windows checklist 7) |
| Error page `link-expired` | past the token's `exp`, or this machine's clock is off |
| Error page `link-reused` | only with `SSO_NCS_SINGLE_USE_LINKS=true`: that exact link was used. Get a fresh one |
| Error page `phone-unverified` | NCS reports the mobile as not verified — Bluedots never creates or links an account on an unverified number |
| Error page `link-conflict` | that mobile belongs to a different NCS user, or to several Bluedots accounts |
| Error page `session-expired` | the login was interrupted mid-way, or Keycloak had a different user logged in. Open the link again |
| Keycloak page "Unexpected error when authenticating with identity provider" | Keycloak cannot reach `SSO_API_INTERNAL_BASE_URL`, or its `SSO_OIDC_CLIENT_SECRET` differs from the API's — re-run `apply-sso-idp.sh` with the right values |
| Lands on the normal OTP login screen | the `identity-provider-redirector` step is missing — re-run `apply-sso-idp.sh` |
| `keycloak-init` log: `sh: \r: not found` / `illegal option` | CRLF line endings (Windows checklist 1) |
| `apply-sso-idp.sh` 404s on `…/flows/bluedots-otp-browser/…` | your realm's browser flow has another name (e.g. a shared realm uses `aggregator-otp-browser`). Run it with `BROWSER_FLOW=<that name>` |

Turning SSO off again: remove `SSO_PROVIDERS` (or set it empty) and restart the
API. The Keycloak configuration can stay; it does nothing without SSO requests.
