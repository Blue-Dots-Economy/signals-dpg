# Faster page load: compression, caching and duplicate requests — design

Issues: #880 and #881 (sub-issues of story #854). Branch `perf/880-881-load-speed`, stacked on `perf/854-map-freeze` (#892).

## Why

- #880: the app JS (2.6 MB), map markers (up to 2.3 MB per request) and network schemas are sent uncompressed. Built JS/CSS files have no cache header, so browsers ask for them again.
- #881: one page load asks for the schemas 3×, the session 4–5× and the listing feed 3–4×. Signed-out visitors get a consent error in the console, and map markers start loading ~1.8 s after the page opens.

## What we measured (local, `/?view=map`)

| | Signed out | Signed in |
|---|---|---|
| API requests | 20 | 29 |
| Schemas | 3 | 3 |
| Session check | 5 | 1 |
| Discover + markers | 4 + 6 | 7 + 7, in two waves; wave 1 is thrown away |
| Consent status | 1 → 401 | 1 |

Live seeker site: `/assets/index-*.js` is 2,591,151 bytes with no `Content-Encoding` and no `Cache-Control`. `/api/v1/network/schemas` is not compressed either.

## Root causes

1. Three hooks fetch `GET /api/v1/network/schemas` separately: `useNetworkConfigs` (no param), `useNetworkConfig(id)` and `useConsentConfig`. The route is a pure filter, so the no-param answer contains everything the other two need.
2. The API client's request interceptor calls `fetchBffSession()` before every non-GET request that has no CSRF token. Signed-out visitors never have one, so every discover POST checks the session again.
3. On the home page, the browse totals, the list feed and the map count start before auth and the user's own profiles have resolved. They run with signed-out settings, then run again with the right domains and anchor.
4. `useConsentGate` asks for consent status whenever a theme exists, signed in or not.
5. Nothing in the chain compresses: the UI nginx server block (written by the Dockerfile entrypoint) has no gzip and no cache rules, and the API registers no compression plugin.

## Design

### #880

1. **UI nginx** (entrypoint server block in `apps/ui/Dockerfile`):
   - `gzip on`, `gzip_vary on`, level 5, minimum length 1 KB, for JS, CSS, JSON, SVG and plain text. Stock nginx has no brotli, so gzip only.
   - `/assets/` (hashed file names): `Cache-Control: public, max-age=31536000, immutable`.
   - `index.html` (including the SPA fallback) and `/config.js`: `no-cache`, so a new deploy shows at once. The host-binding `config.js` branch keeps its `no-store`.
   - Covers the signals variant (root) and the tourist variant (`/tourist`).
2. **API**: register `@fastify/compress` (approved new dependency). br and gzip, chosen by `Accept-Encoding`, threshold 1 KB, brotli quality 4. Types that are already compressed, such as the xlsx export, are left alone. CORS exposed headers and the export download must keep working.

### #881

3. **Schemas once**: one shared query for the no-param schemas response. Network list, single network config and consent config are all derived from it with React Query `select`. 3 requests → 1.
4. **Session once**: the interceptor reuses the page's session check (the in-flight or already-finished one) instead of starting a new one per POST. The first-login race stays safe: a write that starts before the session has loaded still waits for it, and a login refreshes the shared result.
5. **No thrown-away first wave**: browse totals, the list feed and the map count wait until auth has resolved and, when signed in, the user's own profiles have loaded.
6. **Consent status only when signed in**: no 401 for visitors.

## Non-goals

- Skipping the list feed while the map is open (user decision: leave it out).
- Making the session check wait less on auth config.
- Brotli in nginx, a CDN or Kong plugins.
- Any new API endpoint or change to an API contract.

## Done when

- Tests for each change pass, the full UI suite and `pnpm typecheck` pass.
- The local request log (signed out and signed in) shows schemas 1, session 1, no first wave, no consent 401, and when full markers start, compared with the table above.
- nginx headers checked by running the stock `nginx:alpine` image with the generated server block and the built `dist` mounted (no image build).
- After deploy: before/after response sizes recorded on dev, and Kong confirmed to pass `Content-Encoding` through.
