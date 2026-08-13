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

# NOTE: there are deliberately no VITE_AUTH_PROVIDER / VITE_KEYCLOAK_* build
# args. Which login screen to render, and the OIDC connection details, come from
# GET /api/v1/auth/config at runtime — see apps/ui/src/lib/keycloak-config.ts.
# Baking them in once caused a bundle built for Keycloak to redirect every user
# into an OIDC flow while the API was still on better-auth. They can still be
# overridden per-deployment through window.__DPG_UI_CONFIG__ (/config.js), which
# cannot go stale inside an image.
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
# Optional host-routed served binding. When UI_HOST_BINDINGS is set (a
# ";"-separated list of "<host>=<network>/<domain>" pairs, injected by the deploy
# chart) nginx picks VITE_SERVED_BINDINGS per request from the Host header, so a
# single instance can serve several per-domain portals (e.g. provider + seeker)
# from one pod. The chart's config.js carries a "__SERVED_BINDINGS__" placeholder
# that sub_filter rewrites to the host's binding ("" for an unmapped host →
# serve-all, which parseServedScope already treats as "all domains"). Unset →
# today's static /config.js, byte-for-byte.
ENV UI_HOST_BINDINGS=""
COPY <<'EOF' /docker-entrypoint.d/40-ui-variant.sh
#!/bin/sh
set -e
ROOT=/usr/share/nginx/html
if [ "$UI_VARIANT" = "tourist" ]; then
  ROOT=/usr/share/nginx/html/tourist
fi

if [ -n "$UI_HOST_BINDINGS" ]; then
  # Build the per-request "$host -> $served_binding" map from UI_HOST_BINDINGS.
  MAP_ENTRIES=""
  OLDIFS=$IFS
  IFS=';'
  for pair in $UI_HOST_BINDINGS; do
    host=${pair%%=*}
    binding=${pair#*=}
    [ -n "$host" ] && [ -n "$binding" ] || continue
    MAP_ENTRIES="${MAP_ENTRIES}        ${host} \"${binding}\";
"
  done
  IFS=$OLDIFS
  # `map` must sit in the http{} context; conf.d/*.conf is included there, so a
  # top-of-file map block is valid. `hostnames` => case-insensitive host match.
  MAP_BLOCK="map \$host \$served_binding {
        hostnames;
        default \"\";
${MAP_ENTRIES}    }"
  # Rewrite the placeholder in the mounted config.js with the matched binding.
  CONFIG_LOCATION="location = /config.js {
        alias /usr/share/nginx/html/config.js;
        sub_filter_once on;
        sub_filter_types application/javascript text/javascript;
        sub_filter '__SERVED_BINDINGS__' '\$served_binding';
        add_header Cache-Control \"no-store\" always;
    }"
else
  MAP_BLOCK=""
  CONFIG_LOCATION="location = /config.js { alias /usr/share/nginx/html/config.js; }"
fi

cat > /etc/nginx/conf.d/default.conf <<NGINXCONF
${MAP_BLOCK}
server {
    listen 80;
    root ${ROOT};
    index index.html;
    ${CONFIG_LOCATION}
    location / { try_files \$uri /index.html; }
}
NGINXCONF
echo "[ui-variant] serving '${UI_VARIANT:-signals}' from ${ROOT}${UI_HOST_BINDINGS:+ (host-routed: ${UI_HOST_BINDINGS})}"
EOF
RUN chmod +x /docker-entrypoint.d/40-ui-variant.sh
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
