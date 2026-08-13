# Custom Keycloak image for signals-dpg (the shared `bluedots` realm).
#
# Bakes the OTP SPI provider jar into /opt/keycloak/providers, copies the OTP
# theme, and pre-runs `kc.sh build` so the SPI and the persistence layer are
# indexed at image build time rather than at every container start. That lets
# the pod start with `kc.sh start --optimized` for a faster cold boot.
#
# Build:
#   docker build -f infra/keycloak/Dockerfile \
#     -t signals-dpg/keycloak:26.5.5-bluedots infra/keycloak
#
# Notes:
#   * The local-setup compose does NOT use this image — it runs the stock
#     Keycloak with providers/ and themes/ bind-mounted and `start-dev`, so a
#     changed jar or theme is picked up without a rebuild. This file is for
#     Kubernetes, mirroring aggregator-dpg/infra/keycloak/Dockerfile.
#   * render-realm.sh is intentionally NOT copied in: under Kubernetes a
#     realm-renderer initContainer does the placeholder substitution into a
#     shared emptyDir before the main container starts.
#   * KC_DB=postgres is hard-coded so `kc.sh build` precompiles the postgres
#     persistence layer. Another backend would need a different build.
#   * The theme is copied as well as jar-baked so the BRAND_* env vars in
#     theme.properties resolve at request time — see README.md.

ARG KEYCLOAK_VERSION=26.5.5
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}

USER 0
COPY providers/ /opt/keycloak/providers/
COPY themes/ /opt/keycloak/themes/
RUN chmod -R a+r /opt/keycloak/providers /opt/keycloak/themes

USER 1000
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_HTTP_RELATIVE_PATH=/auth

RUN /opt/keycloak/bin/kc.sh build

# Ready-probe against the management interface (port 9000, which inherits
# KC_HTTP_RELATIVE_PATH). The image ships no curl/wget, so this uses bash's
# /dev/tcp as Keycloak's own docs recommend. Kubernetes ignores Docker
# HEALTHCHECKs (its probes are configured in the chart); this serves plain
# `docker run` users and image scanners.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["/bin/bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/9000 && echo -e 'GET /auth/health/ready HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && grep -q '\"status\": *\"UP\"' <&3"]

ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm"]
