# syntax=docker/dockerfile:1.7

# Build stages run on the DHI *dev* variant: it is the only one that carries a
# shell, apk, corepack and npm. The runtime stage below uses the hardened
# variant, which carries none of them — see the `runner` stage for why that
# forces the production install to happen here rather than there.
FROM dhi.io/node:24-alpine-dev AS base

# libc6-compat is kept here, same as apps/ui/Dockerfile: this stage execs
# several tools that ship prebuilt glibc-only binaries (turbo, typescript's Go
# tsc, @esbuild/*, @rolldown/*, @rollup/*, @tailwindcss/oxide-*) — "no
# node-gyp/prebuild-install in the lockfile" only rules out addons compiled at
# install time, not prebuilt executables. This is a build stage that never
# ships, so the package costs nothing in the final image.
RUN apk add --no-cache libc6-compat && corepack enable

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV TURBO_TELEMETRY_DISABLED=1
ENV CI=true


FROM base AS pruner

# This stage needs the full monorepo context so Turbo can compute the exact
# dependency closure for apps/api and emit a reduced workspace for Docker.
WORKDIR /repo

COPY . .

RUN pnpm dlx turbo@2.9.14 prune api --docker


FROM base AS deps

# Copy only the pruned manifests first so pnpm install stays cached unless the
# dependency graph changes.
WORKDIR /app

COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=pruner /repo/out/json/ ./

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile


FROM base AS builder

# Build only apps/api from the pruned workspace.
WORKDIR /app

COPY --from=deps /app/ ./
COPY --from=pruner /repo/out/full/ ./

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  --mount=type=cache,id=turbo-cache-api,target=/app/.turbo \
  pnpm turbo run build --filter=api

# Reinstall as production-only so the final image does not contain
# devDependencies.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --prod

# Assemble the exact runtime tree — production node_modules included — while a
# shell and pnpm are still available. Previously this install ran inside the
# final image; the hardened runtime variant has no shell, so it has to happen
# in a dev-variant stage and be copied across as a finished directory.
# The inputs below are byte-for-byte what the old runner stage copied, and the
# install command is unchanged, so the resulting dependency closure is identical.
FROM base AS prod-deps

WORKDIR /app

# Copy ONLY what is needed to install deps correctly
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/package.json ./package.json

COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/packages ./packages
COPY --from=pruner /repo/examples ./examples

# Install ONLY api production deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --prod --filter=api...


FROM dhi.io/node:24-alpine AS runner

# Hardened runtime: no shell, no apk, no npm/corepack, runs as `node` (uid 1000).
# That means no RUN instruction is possible past this line — everything the
# image needs must arrive via COPY.
WORKDIR /app

ENV NODE_ENV=production
ENV API_PORT=2742
# TMPDIR is deliberately NOT set. `network_schema_cache.ts` mkdir -p's under
# os.tmpdir(); the hardened base ships /tmp at mode 1777, writable by the
# unprivileged runtime user, so the default is correct. An earlier revision
# pointed TMPDIR at /app/.tmp on the assumption /tmp might be absent — it is
# not, and that dir landed root-owned (a COPY of an empty directory copies no
# entries, so its --chown never applied), crashing the pod with EACCES.

# The finished workspace (node_modules included) built by prod-deps. Copied as
# root-owned and world-readable, matching the previous image, where the install
# also ran as root before the USER switch.
COPY --from=prod-deps /app ./

# Copy built output AFTER deps (important for layer caching)
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Deploy migration assets — the image self-migrates the DB via
# `node apps/api/scripts/migrate.mjs`: extension preflight -> auto-baseline ->
# one drizzle migrate() over apps/api/drizzle/. Invoked directly with node, not
# through the `pnpm --filter api db:migrate:deploy` alias, because pnpm does not
# exist in this image. Prod deps only (drizzle-orm + pg) — no drizzle-kit.
COPY --from=builder /app/apps/api/scripts ./apps/api/scripts
COPY --from=builder /app/apps/api/drizzle ./apps/api/drizzle

EXPOSE ${API_PORT}
USER node

CMD ["node", "apps/api/dist/server.js"]
