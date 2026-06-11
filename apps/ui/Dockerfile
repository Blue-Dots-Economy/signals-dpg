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
# `turbo prune` also omits the root tsconfig files. Vite 8 / rolldown's TS
# transform walks up to the root tsconfig (which `extends ./tsconfig.base.json`)
# when bundling workspace-source imports (@dpg/*), so the build fails with
# "Tsconfig not found /app/tsconfig.base.json" without these. Copy them like
# examples/ above.
COPY tsconfig.base.json tsconfig.json /app/
ARG VITE_API_URL
ARG VITE_NETWORK_NAME
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_NETWORK_NAME=$VITE_NETWORK_NAME
# Build BOTH UI variants into one image:
#   - signals (default `build`)        -> apps/ui/dist            (served at /)
#   - orange tourist (`build:tourist`) -> apps/ui/dist/tourist    (served at /tourist)
# Order matters: the signals build empties dist/ (Vite emptyOutDir); the tourist
# build only empties dist/tourist, so running signals first preserves both.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm turbo run build --filter=ui \
  && pnpm --filter ui run build:tourist

FROM nginx:alpine AS runner
# One image carries both builds: signals at the html root, tourist under /tourist.
COPY --from=builder /app/apps/ui/dist /usr/share/nginx/html
# Deploy-time switch: set UI_VARIANT=tourist to serve the tourist build; anything
# else (default) serves the signals UI. A startup hook (run by nginx's official
# entrypoint before nginx boots) writes the server block with the right docroot.
# /config.js is always served from the html root so the chart's runtime config
# (window.__DPG_UI_CONFIG__) reaches whichever variant is selected.
ENV UI_VARIANT=signals
COPY <<'EOF' /docker-entrypoint.d/40-ui-variant.sh
#!/bin/sh
set -e
ROOT=/usr/share/nginx/html
if [ "$UI_VARIANT" = "tourist" ]; then
  ROOT=/usr/share/nginx/html/tourist
fi
cat > /etc/nginx/conf.d/default.conf <<NGINXCONF
server {
    listen 80;
    root ${ROOT};
    index index.html;
    location = /config.js { alias /usr/share/nginx/html/config.js; }
    location / { try_files \$uri /index.html; }
}
NGINXCONF
echo "[ui-variant] serving '${UI_VARIANT:-signals}' from ${ROOT}"
EOF
RUN chmod +x /docker-entrypoint.d/40-ui-variant.sh
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
