# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS base

# Shared base image: Corepack enables the pinned pnpm version and
# libc6-compat avoids common Alpine runtime issues with native modules.
RUN apk add --no-cache libc6-compat \
  && corepack enable

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

FROM node:24-alpine AS runner

RUN apk add --no-cache libc6-compat && corepack enable

WORKDIR /app

ENV NODE_ENV=production
ENV API_PORT=2742
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

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

# Copy built output AFTER install (important for layer caching)
COPY --from=builder /app/apps/api/dist ./apps/api/dist

EXPOSE ${API_PORT}
USER node

CMD ["node", "apps/api/dist/server.js"]
