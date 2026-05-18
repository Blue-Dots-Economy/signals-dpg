---
title: Running The UI
description: How to run the schema-driven UI locally and what backend routes it expects.
head: []
---

Run the UI from the monorepo root:

```bash
pnpm dev:ui
```

Build it for production:

```bash
pnpm build:ui
```

Preview the production build:

```bash
pnpm preview:ui
```

## Runtime Env

| Variable | Default | Purpose |
|----------|---------|---------|
| `VITE_API_URL` | `http://localhost:3000` | Base URL for the API app |
| `VITE_DEFAULT_API_URL` | — | Preferred default API URL when multiple URLs are configured |
| `VITE_API_URLS` | — | JSON map of named API URLs |
| `VITE_SHOW_INSTANCE_SELECTOR` | dev mode | Forces API instance selector behavior |
| `VITE_NETWORK_ID` | first returned network | Comma-separated allowlist of network ids to expose in the UI |
| `VITE_MAP_PROVIDER` | `leaflet` | Active registered map provider |
| `VITE_GEOCODING_API_URL` | `api.postalpincode.in` | Pincode geocoding endpoint |
| `VITE_VC_WALLET_URL` | — | Base URL for the wallet credential service used by the Dhiway Wallet provider |
| `VITE_VC_WALLET_API_KEY` | — | API key sent to the wallet credential service when fetching verified credentials |
| `VITE_AGENT_URL` | — | Base URL for the DigiLocker agent service |
| `VITE_AGENT_TOKEN` | — | Bearer token used for DigiLocker agent requests |

## Required Backend Routes

| Capability | Endpoint |
|------------|----------|
| Network config discovery | `GET /api/v1/network/schemas` |
| Network-wide item browsing | `GET /api/v1/network/item/fetch` |
| User-owned item discovery | `GET /api/v1/item/fetch` |
| Item creation | `POST /api/v1/item/create` |
| Item update | `PATCH /api/v1/item/:itemId` |
| Action submission | `POST /api/v1/action/perform` |
| Action inbox/outbox | `GET /api/v1/action/fetch` |
| Action event history | `GET /api/v1/action/fetch-events` |
| Action status updates | `POST /api/v1/action/update-status` |
| OTP check/request/verify | `/api/auth/unified-otp/*` |
| Session lookup | `GET /api/auth/get-session` |
| Sign out | `POST /api/auth/sign-out` |
| Wallet code request | `POST <VITE_VC_WALLET_URL>/api/v1/auth/request-code` |
| Wallet code verification | `POST <VITE_VC_WALLET_URL>/api/v1/auth/verify-code` |
| Wallet credential fetch | `GET <VITE_VC_WALLET_URL>/api/v1/verified-credentials` |
| DigiLocker authorization launch | `GET <VITE_AGENT_URL>/api/v1/discover/digilocker-request` |
| DigiLocker credential pull | `POST <VITE_AGENT_URL>/api/v1/discover/digilocker-auth` |

The UI expects `/api/v1/network/schemas` to include entries with `kind === 'network_config'`.

## Startup Flow

1. `HomePage` fetches network configs from the API.
2. `?network=<name>` selects a configured network when present; otherwise the first configured or returned network is used.
3. The selected config is resolved with `resolveNetworkRefs()`.
4. User-owned local items are fetched from local item APIs.
5. Target domain items are fetched through network item APIs.
6. Cards, forms, actions, maps, and action-management screens render from the loaded schemas and action APIs.

## Auth Notes

- `LoginPage` supports both phone and email identifiers.
- OTP verification stores the returned bearer token and hydrates the session in `AuthProvider`.
- `RequireAuth` redirects protected routes to `/auth/login?redirect=...` and returns users to the original path after login.

## Credential Import Notes

- The `Import Credentials` button appears on the profile form only when a schema is active and at least one wallet provider is configured.
- Dhiway Wallet uses the signed-in user's email or phone number as the identifier for code verification and credential retrieval.
- DigiLocker opens an external popup flow and can finish either through a redirect bridge page or by manually pasting the returned code or redirect URL.
- Imported values are merged into the active schema through alias-aware field matching instead of provider-specific per-form code.
