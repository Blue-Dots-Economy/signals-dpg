# Faster page load (#880 + #881) — plan

Spec: `docs/superpowers/specs/2026-11-04-load-speed-design.md`. Branch `perf/880-881-load-speed`, stacked on `perf/854-map-freeze` (#892); the PR targets `perf/854-map-freeze` and is retargeted to `feature` once #892 merges.

Every task is test-first: write the failing test, watch it fail for the right reason, make it pass, then commit. UI tests run through `bash .superpowers/sdd/2026-11-04-load-speed/run-ui-tests.sh <paths>`; API tests through `pnpm --filter api exec vitest run <path> --pool=forks --maxWorkers=2`. Before each commit, `git diff | grep -E '^\+ *(//|#)'` and drop any comment that is not a one-line non-obvious reason.

## Baseline (local, `/?view=map`)

| | Signed out | Signed in |
|---|---|---|
| API requests | 20 | 29 |
| Schemas | 3 | 3 |
| Session check | 5 | 1 |
| Discover + markers | 4 + 6 | 7 + 7, two waves |
| Consent status | 1 → 401 | 1 |

Markers answers, local data near Ghaziabad: job postings 1,495 KB → 274 KB with brotli 4 (10 ms); seekers 591 → 119 KB; service providers 47 → 9 KB. A synthetic 70,000-marker answer: 13.6 MB → 2.8 MB (98 ms brotli 4, 182 ms gzip).

## Task 1 — API compression

Files: `apps/api/package.json`, `apps/api/src/plugins/compression.ts` (new, same shape as `plugins/raw_body.ts`), `apps/api/src/app.ts`, `apps/api/src/plugins/__tests__/compression.test.ts`.

Tests, on a small Fastify app with the same registration:
1. A JSON answer over 1 KB with `Accept-Encoding: br` comes back with `Content-Encoding: br` and `Vary: Accept-Encoding`, and decompresses to the same JSON.
2. With only `gzip` accepted, it comes back gzipped.
3. With no `Accept-Encoding`, it comes back uncompressed and byte-identical to today.
4. An answer under 1 KB is not compressed.
5. An xlsx answer (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`) is not compressed, and the export's exposed CORS headers are still readable.
6. A JSON POST with no `Content-Encoding` still reaches the raw-body capture byte-for-byte (peer HMAC hashes it).

Implementation: `@fastify/compress` ^9.3, `encodings: ['br', 'gzip']`, `threshold: 1024`, brotli quality 4. Request decompression is turned off, since no caller sends compressed bodies and it would sit in front of the peer HMAC raw body. Registered in `buildApp` before the routes.

Also measure: one 70,000-marker answer compressed while three other requests are in flight, so we know other requests are not blocked.

## Task 2 — UI nginx: gzip and cache headers

File: the entrypoint server block in `apps/ui/Dockerfile`.

- `gzip on; gzip_vary on; gzip_comp_level 5; gzip_min_length 1024; gzip_types` for JS, CSS, JSON, SVG and plain text (HTML is always included).
- `location ^~ /assets/`: `Cache-Control "public, max-age=31536000, immutable"` on success only (no `always`), `try_files $uri =404`, so a missing hashed file is an uncached 404, not `index.html` cached for a year. The tourist variant serves its own `index.html` and `/assets/` from its own root, so the same rule covers it.
- `location = /index.html` and the SPA fallback: `Cache-Control "no-cache"`.
- Static `/config.js`: `Cache-Control "no-cache"`. The host-binding branch keeps `no-store`.
- `/brand/`, `/reference/`, `analytics.js`: unchanged.

Check, with no image build: build `dist` locally (signals + tourist), write the server block by running the entrypoint script's heredoc with `ROOT` set, run stock `nginx:alpine` with the conf and `dist` mounted, then curl:
- `/assets/index-*.js` with and without `Accept-Encoding: gzip`: encoding, `Vary`, `Cache-Control`.
- `/`, `/some/spa/route`, `/config.js`, `/tourist/`, `/tourist/assets/*`, a missing `/assets/x.js` (404).
- `nginx -t` for both `UI_VARIANT=signals` and `tourist`, and with `UI_HOST_BINDINGS` set.

The container is removed after the check.

## Task 3 — Schemas asked once

Files: `apps/ui/src/lib/network-api.ts`, `apps/ui/src/lib/consent-api.ts`, `apps/ui/src/hooks/use-network-config.ts`, `apps/ui/src/hooks/use-consent-config.ts`, `apps/ui/src/lib/query-keys.ts`, and their tests.

Tests:
1. Rendering `useNetworkConfigs`, `useNetworkConfig('blue_dot')` and `useConsentConfig` together makes one `GET /api/v1/network/schemas`.
2. Each hook returns what it returns today (network list, one network's config, merged consent config with brand override).
3. An unknown network id still errors with `Network "<id>" not found`.
4. After `useNetworkConfig(id)` resolves, `queryClient.getQueryData(queryKeys.networkConfig(id))` returns the config. `use-profile-consent-accept.tsx` reads it there to decide whether a minor needs guardian OTP, and a miss there sends every minor to OTP.
5. The tourist app's own `networkConfig` query still works.

Implementation: one shared query (the existing `networkConfigs` key) holding the raw entries list. The network config and consent config come from that shared list, and `networkConfig(id)` stays a real cache entry filled from it, so direct cache reads keep working.

## Task 4 — Session checked once

Files: `apps/ui/src/lib/bff-session.ts`, `apps/ui/src/lib/api-client.ts`, `apps/ui/src/contexts/auth-context.tsx`, and `bff-session.test.ts`, `api-client-csrf.test.ts`, `auth-context.test.tsx`.

Tests:
1. Signed out: AuthProvider's check plus four POSTs make one `GET /api/v1/auth/session`.
2. A POST that starts while the first check is in flight waits for it and carries the token it returns (the first-login race).
3. After `clearCsrfToken()` (logout, expiry), the next POST checks again rather than reusing the old answer.
4. A check that came back `unknown` (5xx, offline) is not reused; the next POST retries.
5. Signed in: unchanged, one check, every POST carries the token.

Implementation: `bff-session.ts` keeps the in-flight or last definitive session promise. `fetchBffSession` reuses it, and `clearCsrfToken` drops it. The interceptor still awaits it when there is no token.

## Task 5 — No thrown-away first wave

Files: `apps/ui/src/pages/home-page.tsx`, and a home-page test.

Tests:
1. Signed in: no discover or markers request goes out before `/auth/me` and own items have resolved. Every one that goes out carries the final domains and `anchor_item_id`.
2. Signed out: they start as soon as auth resolves to signed out, with no wait on own items.

Implementation: a `browseReady` flag (`!authLoading && (!user || myItemsFetched)`) added to the `enabled` of `useBrowseTotals`, the list feed (`useInfiniteBrowseItems`) and the map count. The full markers query already waits for the first viewport; it gets the same gate only if the test shows it starting early.

## Task 6 — Consent status only when signed in

Files: `apps/ui/src/hooks/use-consent-gate.ts`, and a new `use-consent-gate.test.tsx`.

Tests: signed out, no `GET /api/v1/consent/status`, and the gate reports nothing needed. Signed in, unchanged.

Implementation: `enabled: !!themeId && isAuthenticated`. The gate's loading state must not hang for visitors.

## Task 7 — Verification

1. Full UI suite (`run-ui-tests.sh`, 2 workers), the API unit suite (`--pool=forks --maxWorkers=2`) and `pnpm typecheck`.
2. `bootreqs.mjs` signed out and signed in, compared with the baseline table: request counts per path, and when the full markers request starts.
3. Browser check at desktop and 390×844: map and list load, domain tabs, own-profile anchor, consent prompt for a signed-in user without consent, nothing extra in the console for visitors.
4. Final review of the whole diff.

## After deploy (not part of this branch's work)

Record before/after response sizes on dev for the JS bundle, schemas and a large markers answer (#880's done-when), and confirm Kong passes `Content-Encoding` through.

## PR description notes

- Title: `perf(ui,api): #880 #881 compress responses and stop duplicate requests on page load`.
- Body: `Closes #880`, `Closes #881`, short plain words, no code details.
- Must say plainly: on fast office Wi-Fi the gain is small; on mobile data, which is how most seekers open the site, it is large. Include the measured sizes (e.g. job-posting map data 1.5 MB → 0.27 MB).
- Note that the API rejects more than 25,000 map markers today, so raising the map cap to 60–70k needs that limit raised too.

## Results (local, 2026-11-04)

Same port for both (Google Maps refuses other ports, so both used the same fallback), two alternating runs each, `/?view=map`:

| | Before | After |
|---|---|---|
| API requests, signed out | 20 | 13 |
| API requests, signed in | 29 | 20 |
| Schemas / session checks (signed out) | 3 / 5 | 1 / 1 |
| Discover + markers, signed in | 7 + 9, two waves | 3 + 4, one wave |
| Consent 401 for visitors | yes | no |
| API bytes over the wire, signed out | 4.09 MB | 0.48 MB |
| API bytes over the wire, signed in | 2.04 MB | 0.36 MB |
| Visitor: list feed starts | ~0.9 s | ~0.9 s |
| Full map markers start | ~1.5 s | ~1.6 s |

Locally everything is on loopback, so start times do not move; the gain is fewer and smaller requests, which matters on mobile data. Waiting for the session check costs visitors nothing measurable (it answers within ~10 ms of auth config).

Compression: all job-posting markers 2,049,669 → 379,983 bytes (brotli 4); synthetic 70,000 markers 13.6 → 2.8 MB (~100 ms). Small requests during four large compressed answers: median 0.2–0.3 ms, worst cases the same as without compression. nginx (stock image, both variants and host-routed): main JS 2,555,289 → 758,272 bytes gzip, unpacks byte-identical.

Browser check: list and counts on desktop and 390×844, signed in and out; map on 5173 (Google) desktop and mobile, signed in (own-profile centre, correct domains) and out (clusters); no "no listings" flash while waiting, no new console errors.
