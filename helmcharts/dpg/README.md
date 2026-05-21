# DPG umbrella chart — deployment guide

Deploy the full DPG stack (api + ui + postgres + redis + schemas service)
into a Kubernetes cluster in one shot. No manual `kubectl create secret`,
no per-component `--set` flags, no edits to `values.yaml` between runs.

## What gets deployed

| Component | What it is |
| --- | --- |
| `dpg-api` | Fastify/Node API (ghcr.io/vinodbhorge/dpg-monorepo/api) |
| `dpg-ui` | Vite/React UI behind nginx (ghcr.io/vinodbhorge/dpg-monorepo/ui) |
| `dpg-postgresql` | Bitnami Postgres 17 (PVC, initdb creates pgcrypto / cube / earthdistance) |
| `dpg-redis` | Bitnami Redis 7 (PVC) |
| `dpg-schemas` | nginx pod serving the network.json files from a ConfigMap |
| `dpg-postgres` / `dpg-redis` / `dpg-api-secrets` | Helm-rendered Secrets |
| `dpg-api-migrate` (Job, hook) | Applies the SQL schema once Postgres is reachable; idempotent |

The umbrella vendors the four subcharts under `helmcharts/dpg/charts/` so
nothing is fetched at install time.

## Prerequisites

- `kubectl` configured against your target cluster
- `helm` 3.x
- `openssl` (for password generation)
- Cluster needs `RWO` PVC support (Postgres + Redis each request 8Gi)
- For local clusters (k3s/colima/kind/minikube) the API and UI images are
  pulled from ghcr.io — confirm the cluster has internet egress. To run a
  local build instead, set `--set api.image.repository=...` etc. on
  `install.sh`'s `helm upgrade` line or commit them into `values.yaml`.

## First-time install

```bash
git clone <your fork>
cd dpg-monorepo
bash helmcharts/dpg/install.sh
```

That's it. The script:

1. Generates three passwords (`PG_PW`, `REDIS_PW`, `AUTH_SECRET`) with
   `openssl rand` and writes them into `helmcharts/dpg/values.yaml` under
   `credentials.*` (existing values are kept, so re-runs are safe).
2. Creates the `dpg` namespace.
3. Runs `helm upgrade --install dpg helmcharts/dpg -n dpg --wait`.
4. Helm renders three Secrets (`dpg-postgres`, `dpg-redis`,
   `dpg-api-secrets`) from those values; subcharts reference them by name.
5. Waits for pods to become Ready and prints the port-forward command.

Open the UI:

```bash
kubectl -n dpg port-forward svc/dpg-ui 8080:80
# browse to http://localhost:8080
```

The API stays `ClusterIP` only — the UI pod's nginx proxies `/api/*` to
`dpg-api` internally, so a single port-forward is enough.

## What lives where

Everything that controls behaviour at deploy time is in
`helmcharts/dpg/values.yaml`:

| Section | Purpose |
| --- | --- |
| `images.*` | Image repos and tags for all four components |
| `resources.*` | CPU / memory limits/requests |
| `credentials.*` | Passwords (populated by `install.sh`) |
| `api.config.*` | Non-secret env (rendered into a ConfigMap) |
| `api.config.SERVED_DOMAINS` | Which `<network>/<domain>` pairs this API serves |
| `api.config.NETWORK_CONFIG_URLS` | Where the API fetches each network's schema |
| `ui.runtimeConfig.*` | Browser-side config (rendered into `/config.js` at runtime — no rebuild needed) |
| `schemas.networks` | List of networks served by the `dpg-schemas` Service |
| `schemas.publicApiUrl` | In-cluster API URL substituted into each network's `instance_url` |

## Adding or editing a network

The `dpg-schemas` Service serves `network.json` files from a ConfigMap.
Helm substitutes two tokens at render time:

- `__PUBLIC_API_URL__` → `schemas.publicApiUrl` (default
  `http://dpg-api:2742`, in-cluster API)
- `__SCHEMAS_URL__` → in-cluster URL of the schemas Service

### Add a new network

1. Drop the file at `helmcharts/dpg/files/networks/<name>.json`. Use
   `__PUBLIC_API_URL__` wherever an instance URL is needed and
   `__SCHEMAS_URL__/<peer>.json` for cross-network `schema_url` fields.
2. Append the name to `schemas.networks:` in `values.yaml`.
3. Append `<name>=http://dpg-schemas/<name>.json` to
   `api.config.NETWORK_CONFIG_URLS`.
4. Add each `<name>/<domain>` pair to `api.config.SERVED_DOMAINS`.
5. Re-run `bash helmcharts/dpg/install.sh`.

### Edit an existing network

1. Edit the JSON under `helmcharts/dpg/files/networks/`.
2. Re-run `bash helmcharts/dpg/install.sh`. Helm picks up the changed
   ConfigMap; `kubectl rollout restart deploy/dpg-schemas` if you don't
   see the change.

## Database schema

The Helm post-install/upgrade hook `dpg-api-migrate` (Job) applies
`helmcharts/api/files/schema.sql` once Postgres is reachable. It:

1. Waits for `pg_isready`.
2. Creates extensions (`pgcrypto`, `cube`, `earthdistance`) using the
   admin creds from `dpg-postgres` — these need superuser.
3. Checks for the `items` table; if present, exits silently.
4. Otherwise applies the full schema in a single transaction.

A copy of the same `CREATE EXTENSION` statements is also wired into
Bitnami's `primary.initdb.scripts` so a fresh PVC has them before the
app user ever connects.

## Uninstall

```bash
helm uninstall dpg -n dpg
kubectl -n dpg delete pvc --all
kubectl delete ns dpg
```

The PVC delete is the only step that destroys data — without it,
Bitnami keeps the Postgres + Redis volumes around and a subsequent fresh
install would reject the new generated passwords (Bitnami stores
passwords in `pg_authid` / Redis ACL inside the volume).

## Re-running after password loss

`install.sh` keeps the existing passwords in `values.yaml`. If you lose
that file but the cluster is still running, recover the values:

```bash
kubectl -n dpg get secret dpg-postgres -o jsonpath='{.data.password}' | base64 -d
kubectl -n dpg get secret dpg-redis -o jsonpath='{.data.redis-password}' | base64 -d
kubectl -n dpg get secret dpg-api-secrets -o jsonpath='{.data.AUTH_SECRET}' | base64 -d
```

Paste them back into the `credentials.*` block in `values.yaml` before
re-running the script — otherwise it generates new ones, Helm tries to
update Bitnami's stored passwords, and the upgrade check rejects them.

## Caveats

- `values.yaml` becomes secret-bearing after the first run. Don't commit
  it. (`git update-index --assume-unchanged helmcharts/dpg/values.yaml`
  on the working copy is a low-effort way to keep it out of diffs.)
- The umbrella's centralized values use YAML anchors (`*api_image`,
  `*pg_password`, ...). `helm install --set images.api.tag=...` does
  **not** propagate through anchors. Override `api.image.tag` (or edit
  `values.yaml`) instead.
- `ALLOWED_ORIGINS` defaults to `http://localhost:8080` to match the
  port-forward. If you expose the UI via an Ingress, update that value.
