# NCS demo portal

A local stand-in for the National Career Service portal, for testing Bluedots
partner SSO (`docs/operations/partner-sso.md`) without access to NCS. It is
both halves of NCS:

- **the portal** — log in as a test job seeker, click **Open Bluedots**, and the
  browser is redirected to Signals with an NCS-style signed link
  (`?userName=<HS256 JWT>&sig=<CryptoJS AES>&expiry=&featureKey=`);
- **the partner API** Signals calls back — `POST /api/integration/validate-token`,
  with the HMAC check NCS documents.

Node built-ins only; nothing to install. Local testing only.

## Run it

```bash
# one shared secret for the demo and the Signals API
export NCS_SECRET=$(openssl rand -hex 32)

NCS_DEMO_CLIENT_SECRET=$NCS_SECRET \
NCS_DEMO_CLIENT_ID=bluedots-local \
SIGNALS_SSO_URL=http://localhost:2742/api/v1/auth/sso/login \
node local-setup/ncs-demo/server.mjs
```

Then open <http://localhost:4555>.

## Point Signals at it

The API needs `AUTH_PROVIDER=keycloak` and Keycloak running
(`docker compose --profile keycloak up -d` in `local-setup/`, which also runs
`infra/keycloak/init/apply-sso-idp.sh`). Add to the root `.env`:

```bash
SSO_PROVIDERS=ncs
SSO_NCS_BASE_URL=http://localhost:4555
SSO_NCS_CLIENT_ID=bluedots-local
SSO_NCS_CLIENT_SECRET=<$NCS_SECRET>
SSO_OIDC_CLIENT_SECRET=<openssl rand -hex 32; same value for Keycloak's SSO_OIDC_CLIENT_SECRET>
SSO_OIDC_SIGNING_KEY="<openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt>"
SSO_NCS_MAPPING={"network":"blue_dot","role_to_domain":{"JOBSEEKER":"seeker"},"fields":{"fullName":"name","mobileNumber":"phone"},"feature_routes":{"placement-prep":"/"},"app_origin":"http://localhost:5173"}
```

For the UI's "Back to NCS" button, set `VITE_SSO_PARTNER_URL=http://localhost:4555/home`
and `VITE_SSO_PARTNER_NAME=NCS`.

## What to try

| Button / user | Expected |
|---|---|
| Asha or Ravi → **Open Bluedots** | lands in Bluedots logged in, draft profile under My Profiles |
| same user again | same account, no second profile |
| **Add a test user** with the mobile of an existing Bluedots account (verified) | logs in to that existing account |
| same, but *mobile unverified* | error page: `phone-unverified` |
| **Re-open the last link** | error page: `link-reused` |
| **Expired link** / **Tampered link** | error page: `link-expired` / `link-invalid` |
| Blocked User → **Open Bluedots** | error page: `account-inactive` |
| log in to Bluedots as someone, then Open Bluedots as another NCS user in the same browser | the first session ends; the NCS user is logged in |

Test users start with `99999100xx` numbers so they are easy to find and remove.
