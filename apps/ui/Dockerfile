# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat && corepack enable
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV TURBO_TELEMETRY_DISABLED=1
ENV CI=true

FROM base AS pruner
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@2.9.4 prune ui --docker

FROM base AS deps
WORKDIR /app
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=pruner /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/ ./
COPY --from=pruner /repo/out/full/ ./
# `turbo prune ui --docker` doesn't pull in examples/schemas/, but the
# brand-theme Vite plugin (apps/ui/vite.config.ts) reads each network's
# brand.json from that tree to emit [data-network=<id>]{...} CSS blocks
# into index.html at build time. Without these files the deployed UI has
# no per-network token block and every network falls back to the default
# :root palette (blue-leaning) — visible as "Blue Dots" colours on the
# Orange Dots deployment. Copy the brand.json files explicitly.
COPY examples/schemas/ /app/examples/schemas/
ARG VITE_API_URL
ARG VITE_NETWORK_NAME
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_NETWORK_NAME=$VITE_NETWORK_NAME
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm turbo run build --filter=ui

FROM nginx:alpine AS runner
COPY --from=builder /app/apps/ui/dist /usr/share/nginx/html
RUN printf 'server { listen 80; root /usr/share/nginx/html; index index.html; location / { try_files $uri /index.html; } }\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
