# Single-instance, host-routed served-binding — Design

**Date:** 2026-06-17
**Branch:** `feat/host-routed-served-binding` (from `feature`)
**Status:** Design pending user review → implementation plan
**Builds on:** [Per-domain Signals UI split](./2026-06-15-per-domain-ui-split-design.md) (PR #178)

## Goal

Serve **two (or N) domain portals from a single UI deployment**, selecting the
served binding **per request from the `Host` header** instead of per
deployment. Today `bluedotssignals.provider.org` and
`bluedotssignals.seeker.org` each require their own Deployment+pod, each baking
a different `VITE_SERVED_BINDINGS` into a static `config.js`. We want both
hostnames to resolve to **one** UI instance (one pod, one set of resources),
with the instance behaving as the provider portal when reached via the provider
host and as the seeker portal when reached via the seeker host.

This is purely a **delivery** change. The per-domain UI behaviour built in
PR #178 — `getServedScope()`, the login domain gate, browse scoping, network
pinning, per-domain tab title — is **unchanged and untouched**. Only *how the
bytes of `/config.js` are produced* changes: from a static file with one fixed
value to a host-aware response.

## Why this is possible (the key fact)

PR #178 reads the binding at **runtime**, not build time. The chain is:

```
getServedScope()                         // apps/ui/src/lib/served-binding.ts
  → getRuntimeEnv('VITE_SERVED_BINDINGS') // apps/ui/src/lib/runtime-env.ts
    → window.__DPG_UI_CONFIG__            // set by /config.js, loaded before React boots
```

`/config.js` is fetched by the browser at page load, before `main.tsx`. The
hashed JS/CSS bundle is **binding-agnostic** — the same bytes work for any
binding. So if `/config.js` returns a different `VITE_SERVED_BINDINGS` depending
on the request `Host`, a single instance serves multiple portals with **zero
application-code change**.

The only thing standing in the way today is *how* `/config.js` is served.

## What blocks it today (one line)

`apps/ui/Dockerfile`, the `40-ui-variant.sh` startup hook, emits:

```nginx
location = /config.js { alias /usr/share/nginx/html/config.js; }
```

That `alias` serves a **single static file**, mounted from the Helm ConfigMap
(`helm/signals/charts/ui/templates/configmap.yaml`):

```yaml
data:
  config.js: |
    window.__DPG_UI_CONFIG__ = {{ .Values.runtimeConfig | toJson }};
```

A statically-mounted file has the same bytes for every request — it **cannot**
vary by `Host`. To branch on `Host`, the serving of `/config.js` must move into
a layer that sees the request: **nginx inside the pod** (this design, "A1") or
Kong in front of it (rejected alternative, see below).

## Approach (A1): nginx `map $host` → dynamic `/config.js`

Replace the static `alias` with a per-request `return 200` whose
`VITE_SERVED_BINDINGS` value is selected by an nginx `map` keyed on `$host`. The
host→binding table and the other runtime-config values are injected by Helm as
**environment variables**, so the *mechanism* lives in the image (generic,
network-agnostic) and the *data* lives in the automation repo (per deployment).

### Request flow

```
provider.org ┐                              ┌─ $host matches provider ─► config.js = { VITE_SERVED_BINDINGS:"bluedots/provider", … }
             ├─► Kong ─► ONE UI pod ─► nginx ┤
seeker.org   ┘   (both hosts → same svc)     └─ $host matches seeker   ─► config.js = { VITE_SERVED_BINDINGS:"bluedots/seeker",   … }

  then the SAME hashed bundle loads for both hosts, reads window.__DPG_UI_CONFIG__,
  getServedScope() returns the host-appropriate scope, and every PR-#178 behaviour
  (gate, browse scoping, network pin, tab title) works unchanged.
```

## Architecture

### Component 1 — host→binding mechanism in the image (`apps/ui/Dockerfile`)

The `40-ui-variant.sh` startup hook is extended so the generated nginx config:

1. Builds a `map $host $served_binding { … }` block from an injected env var
   describing host→binding pairs.
2. Serves `/config.js` dynamically, interpolating `$served_binding` plus the
   shared runtime-config values (API URL, network name) into the
   `window.__DPG_UI_CONFIG__` body, with `Cache-Control: no-store`.

Sketch of the generated server block (illustrative — exact escaping handled in
the heredoc):

```nginx
map $host $served_binding {
    default            "";                     # unknown host → serve-all (safe fallback)
    ~*provider         "bluedots/provider";
    ~*seeker           "bluedots/seeker";
}

server {
    listen 80;
    root   /usr/share/nginx/html;
    index  index.html;

    location = /config.js {
        default_type application/javascript;
        add_header Cache-Control "no-store" always;
        return 200 'window.__DPG_UI_CONFIG__ = { "VITE_SERVED_BINDINGS":"$served_binding", "VITE_API_URL":"$cfg_api_url", "VITE_NETWORK_NAME":"$cfg_network" };';
    }

    location / { try_files $uri /index.html; }
}
```

Inputs (injected by Helm as container env, parsed by the hook):

- `UI_HOST_BINDINGS` — the host→binding table, e.g.
  `provider=bluedots/provider;seeker=bluedots/seeker`. The hook expands each
  pair into a `map` entry (host pattern → quoted binding).
- The existing runtime-config values (`VITE_API_URL`, `VITE_NETWORK_NAME`, and
  any other keys today carried in `runtimeConfig`) — injected as env and woven
  into the returned body.

Design rules for the hook:

- **Backward compatible.** When `UI_HOST_BINDINGS` is unset/empty, the hook
  emits the current static-`config.js` behaviour byte-for-byte (it keeps the
  `alias` to the mounted file). Host routing is strictly opt-in.
- **Network-agnostic.** No `bluedots`/`provider`/`seeker` literals in the image;
  everything comes from `UI_HOST_BINDINGS`. The same image serves any network.
- **Unknown host → serve-all** (`$served_binding = ""`), which `parseServedScope`
  already treats as "serve all domains" — a safe, non-broken fallback rather
  than a hard error.
- **Tourist variant unaffected.** The `UI_VARIANT=tourist` path is untouched;
  host routing only rewrites the `/config.js` location of the signals variant.

### Component 2 — multi-host ingress (automation repo)

`helm/signals/charts/ui/templates/ingress.yaml` currently hardcodes a single
`global.publicHost` in both `rules:` and `tls.hosts:`. It is templated over a
**list of hosts**, all pointing at the same `dpg-ui` service, and the TLS block
lists all hosts as SANs on one cert (cert-manager issues a multi-SAN cert):

```yaml
spec:
  tls:
    - hosts: {{- range .Values.ingress.hosts }}
        - {{ . | quote }}
      {{- end }}
      secretName: {{ .Values.ingress.tlsSecret }}
  rules:
    {{- range .Values.ingress.hosts }}
    - host: {{ . | quote }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ $fullName }}
                port: { number: {{ $.Values.service.port }} }
    {{- end }}
```

`ingress.hosts` defaults to `[ global.publicHost ]` so single-host deployments
are unchanged. The API ingress (`charts/api/templates/ingress.yaml`) keeps its
single `global.publicHost` — the API already serves both domains via
`SERVED_DOMAINS` and needs no host split.

### Component 3 — Helm values + deployment wiring (automation repo)

- `helm/signals/charts/ui/templates/deployment.yaml` passes the new env to the
  container alongside the existing `API_UPSTREAM`:

  ```yaml
  env:
    - name: UI_HOST_BINDINGS
      value: {{ .Values.hostBindings | quote }}     # "provider=...;seeker=..."
    - name: VITE_API_URL
      value: {{ .Values.runtimeConfig.VITE_API_URL | quote }}
    - name: VITE_NETWORK_NAME
      value: {{ .Values.runtimeConfig.VITE_NETWORK_NAME | quote }}
  ```

- `helm/signals/values.yaml` gains `ui.hostBindings` and `ui.ingress.hosts`,
  e.g.:

  ```yaml
  ui:
    ingress:
      hosts:
        - bluedotssignals.provider.org
        - bluedotssignals.seeker.org
    hostBindings: "bluedotssignals.provider.org=bluedots/provider;bluedotssignals.seeker.org=bluedots/seeker"
  ```

- The static `config.js` ConfigMap mount stays (it is the unset-fallback path),
  but when `UI_HOST_BINDINGS` is set the dynamic `location = /config.js` takes
  precedence and the mounted file is not used for the binding.

### Component 4 — backward compatibility

- **Image:** with `UI_HOST_BINDINGS` unset, the entrypoint emits exactly today's
  nginx config (static `config.js` alias). No existing deployment changes
  behaviour until it opts in.
- **Chart:** `ingress.hosts` defaults to `[global.publicHost]`; `hostBindings`
  defaults to `""`. A chart user who upgrades without setting either gets
  identical rendered manifests.
- **App:** no TypeScript changes at all. `getServedScope()` and every consumer
  are byte-for-byte unchanged.

## Rejected alternative (A2): Kong owns `/config.js`

A Kong `pre-function`/`serverless` plugin on a `/config.js` route could
terminate the request and return a host-specific body before it reaches the pod
— giving **literally zero** changes in this repo. Rejected as the default
because the runtime-config logic would live in a Kong-specific Lua snippet:
less discoverable, harder to unit-test, and coupled to Kong (the nginx approach
works under any ingress). Kept on file as a fallback if keeping the image
byte-identical ever becomes a hard requirement.

## Deployment topology

- **One image** (`UI_VARIANT=signals`, unchanged build), **one Deployment**,
  **one pod** (sized for combined provider+seeker load).
- **One ingress, two hosts** → same `dpg-ui` service; one multi-SAN TLS cert.
- **One API instance** with `SERVED_DOMAINS="bluedots/seeker,bluedots/provider"`
  — already the case today; no API change. Both UI hosts use the same
  `VITE_API_URL`.

Tradeoff vs. the PR-#178 two-instance topology: a single pod now serves both
audiences, so you lose per-domain blast-radius isolation and must size for
combined load. Accepted, since consolidating to one instance is the explicit
goal.

## Caveats (must address in implementation)

1. **Caching — the #1 risk.** `/config.js` is one URL returning different bodies
   per host. It **must** carry `Cache-Control: no-store` and must never be
   cached by any shared layer (Kong proxy-cache / CDN) without keying on `Host`.
   The hashed bundle stays normally cacheable.
2. **`checksum/config` rollout.** `deployment.yaml` rolls the pod when the
   ConfigMap hash changes. With the binding sourced from env, changing a binding
   is a `hostBindings` env change (which also rolls the pod via the Deployment
   spec change) rather than a ConfigMap change — verify the rollout still
   triggers on `hostBindings`/`ingress.hosts` edits.
3. **Host matching.** `map` patterns must match the real `Host` (case-insensitive
   `~*`, exact hostnames preferred over loose substrings to avoid a host like
   `provider-seeker.…` matching both). Implementation uses exact host keys from
   `UI_HOST_BINDINGS`, not substrings.
4. **Unknown host fallback.** Defaults to `""` → serve-all. Decide whether a
   stricter "reject unknown host" is wanted; default is permissive.
5. **Session safety.** A browser session lives on one host, so the memoized
   `getServedScope()` / module-init reads are correct — no mid-session host
   switch.

## Local testability (Colima + Helm)

**Yes, testable locally**, in two tiers. The decision on whether to do the full
k8s test is deferred to after this design is approved.

### Tier 1 — image only (fastest, no cluster, validates the core mechanism)

Build the UI image with the modified `Dockerfile`, run it with
`UI_HOST_BINDINGS` set, and curl `/config.js` with different `Host` headers:

```bash
docker build -t signals-ui:hosttest -f apps/ui/Dockerfile .
docker run -d -p 8080:80 \
  -e UI_HOST_BINDINGS="provider.local=bluedots/provider;seeker.local=bluedots/seeker" \
  -e VITE_API_URL="http://localhost:2742" -e VITE_NETWORK_NAME="bluedots" \
  signals-ui:hosttest
curl -s -H 'Host: provider.local' localhost:8080/config.js   # expect bluedots/provider
curl -s -H 'Host: seeker.local'   localhost:8080/config.js   # expect bluedots/seeker
curl -s -H 'Host: unknown.local'  localhost:8080/config.js   # expect "" (serve-all)
```

This proves the whole mechanism without Kubernetes and is the recommended first
gate.

### Tier 2 — full Helm deploy on Colima

Feasible with caveats:

- **Cluster:** `colima start --kubernetes` (or k3s/kind) provides the cluster.
- **Image:** local registry or load the built image into the node
  (`colima` / `k3s ctr images import`, or `kind load docker-image`) and set
  `image.pullPolicy: IfNotPresent` so it doesn't try GHCR.
- **DNS:** add both hostnames to `/etc/hosts` pointing at the ingress
  (`127.0.0.1 bluedotssignals.provider.org bluedotssignals.seeker.org`, or the
  Kong LB IP).
- **TLS / cert-manager:** Let's Encrypt HTTP-01 **cannot** issue for these names
  locally (no public DNS). For local runs either disable TLS on the ingress
  (`ingress.tlsSecret: ""`, serve over HTTP) or use a self-signed/`selfSigned`
  cluster-issuer and accept the browser warning. The host-routing logic itself
  is independent of TLS.
- **Then:** `helm upgrade --install` the signals chart with `ui.ingress.hosts`
  and `ui.hostBindings` set; browse both hosts and confirm provider vs seeker
  portal behaviour from one pod.

Recommendation: gate on **Tier 1** first (cheap, deterministic); run **Tier 2**
only if we want end-to-end confidence before deploying to the real cluster.

## Testing

- **Mechanism (Tier 1, scripted):** `/config.js` body varies correctly by
  `Host`; unknown host → serve-all; unset `UI_HOST_BINDINGS` → byte-for-byte
  today's static `config.js`.
- **App behaviour (Tier 2, manual):** via provider host → no network selector,
  browse targets = seekers(+providers), create goes straight to provider form,
  a seeker login is gated with the name-only message; via seeker host → seeker
  portal behaviour. Both from the **same** pod.
- **Regression:** a single-host deployment with `hostBindings` unset and
  `ingress.hosts` defaulted renders identical manifests and behaves as today.
- **No new unit tests in the app** — no app code changes. The PR-#178 unit
  suites (`served-binding`, `visible-domains`, `domain-gate`) still cover the
  consumption side.

## Out of scope

- Any change to PR-#178 application logic (gate, scoping, pinning, title).
- Per-domain theming (theme stays network-scoped, as in PR #178).
- API/backend changes — the API already serves both domains via `SERVED_DOMAINS`.
- The Kong-plugin alternative (A2) — documented above, not implemented.
- Multi-network on one host (a host maps to exactly one `network/domain` here;
  multi-domain whitelists per host are possible by mapping a host to a
  comma-separated binding, but are not a target of this design).

## Open items

1. **Unknown-host policy** — permissive serve-all (default) vs. reject. Default
   chosen; confirm.
2. **Local TLS choice for Tier 2** — HTTP (no TLS) vs. self-signed issuer.
   Decide if/when we run Tier 2.
3. **Whether to run Tier 2 at all** before deploying to the shared cluster
   (per user — to be decided after this design).
