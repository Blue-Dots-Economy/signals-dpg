# DPG Helm Charts

Charts for deploying the DPG monorepo on Kubernetes.

## Layout

| Path | Purpose |
| --- | --- |
| `dpg/` | **Umbrella chart** — bundles all four below with centralized values |
| `api/` | API service (Fastify/Node) |
| `ui/` | UI (Vite/React + nginx) |
| `postgresql/` | Vendored Bitnami PostgreSQL `18.6.6` (app `18.4.0`) |
| `redis/` | Vendored Bitnami Redis `19.6.4` (app `7.2.5`) |

## Recommended: install via umbrella

Single command. Single values file. All image / resource / credential settings
live in `helmcharts/dpg/values.yaml` under three top sections (`images`,
`resources`, `credentials`) and fan out to subcharts via YAML anchors — you
edit one place, every chart picks it up.

```bash
# 1. Create the postgres / redis secrets in the target namespace
kubectl create secret generic dpg-postgres \
  --from-literal=postgres-password=<admin-pw> \
  --from-literal=password=<user-pw>

kubectl create secret generic dpg-redis \
  --from-literal=redis-password=<redis-pw>

# 2. Resolve subchart dependencies (one-time after Chart.yaml changes)
helm dependency update ./helmcharts/dpg

# 3. Install / upgrade
helm upgrade --install dpg ./helmcharts/dpg \
  --set credentials.api.data.AUTH_SECRET=<random> \
  --set credentials.api.data.POSTGRES_PASSWORD=<user-pw> \
  --set credentials.api.data.REDIS_PASSWORD=<redis-pw>
```

Override an image tag for one component:

```bash
helm upgrade dpg ./helmcharts/dpg --set images.api.tag=v1.2.3
```

Override resources for one component:

```bash
helm upgrade dpg ./helmcharts/dpg \
  --set-json 'resources.api={"limits":{"cpu":"500m","memory":"512Mi"}}'
```

> The umbrella assumes the release name is `dpg` for the in-cluster Postgres /
> Redis service DNS (`dpg-postgresql`, `dpg-redis-master`). If you change the
> release name, also set `api.postgres.host` and `api.redis.host`.

## Centralized values reference

Edit only these three sections in `helmcharts/dpg/values.yaml`:

| Section | Drives |
| --- | --- |
| `images.api`, `images.ui`, `images.postgresql`, `images.redis` | All container images |
| `resources.api`, `resources.ui`, `resources.postgresql`, `resources.redis.master`, `resources.redis.replica` | All resource limits/requests |
| `credentials.postgresql.existingSecret`, `credentials.redis.existingSecret`, `credentials.api.data.*` | All secret material |

The per-subchart blocks below (`api:`, `ui:`, `postgresql:`, `redis:`) consume
those sections via YAML anchors — do not duplicate values there.

## Standalone install (legacy)

The individual charts still work on their own. Use the per-chart override
files if you prefer separate releases:

```bash
helm upgrade --install dpg-postgres ./helmcharts/postgresql \
  -f ./helmcharts/dpg-postgresql-values.yaml

helm upgrade --install dpg-redis ./helmcharts/redis \
  -f ./helmcharts/dpg-redis-values.yaml

helm upgrade --install dpg-api ./helmcharts/api --set image.tag=<tag> ...
helm upgrade --install dpg-ui  ./helmcharts/ui  --set image.tag=<tag> ...
```

Note: standalone path does **not** share the centralized values. Prefer the
umbrella unless you need separate release lifecycles.
