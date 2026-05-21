#!/usr/bin/env bash
# Install / upgrade / uninstall the DPG umbrella chart.
#
# Single source of truth is values.yaml. Generated passwords are written
# into values.yaml itself (postgresql.password / redis.password /
# api.authSecret under credentials:). Helm renders them into Secrets via
# templates/secrets.yaml; subcharts consume those Secrets by name.
#
# Usage:
#   bash install.sh                  # install or upgrade (default)
#   bash install.sh install
#   bash install.sh cleanup          # uninstall release, drop PVCs + ns,
#                                    # reset password placeholders in values.yaml
#   bash install.sh cleanup --yes    # skip the confirmation prompt
#
# Re-running install is safe: existing passwords in values.yaml are kept.
#
# Overridable via env:
#   RELEASE     Helm release name           (default: dpg)
#   NAMESPACE   Kubernetes namespace        (default: dpg)

set -euo pipefail

RELEASE=${RELEASE:-dpg}
NAMESPACE=${NAMESPACE:-dpg}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHART_DIR="$SCRIPT_DIR"
VALUES_FILE="$CHART_DIR/values.yaml"

for bin in helm kubectl openssl sed; do
  command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 1; }
done

# -------------------------------------------------------------------------
# generate_passwords
#   Reads the three credential fields from values.yaml. For any that are
#   still the empty placeholder ("") an openssl-generated value is written
#   back in place. Uses sed anchored to the inline `# PG_PW|REDIS_PW|
#   AUTH_SECRET` marker so the surrounding YAML / anchors stay intact.
#   Re-runnable: filled values are preserved.
# -------------------------------------------------------------------------
generate_passwords() {
  local file=$1
  _write_if_empty() {
    local marker=$1 newval=$2
    # Match `password: ""  # MARKER` and `password: &anchor ""  # MARKER`.
    if grep -qE "^[[:space:]]+(password|authSecret):[[:space:]]+(&[A-Za-z_][A-Za-z0-9_]*[[:space:]]+)?\"\"[[:space:]]+# ${marker}\$" "$file"; then
      sed -i -E \
        "s,^([[:space:]]+(password|authSecret)):[[:space:]]+(&[A-Za-z_][A-Za-z0-9_]*[[:space:]]+)?\"\"[[:space:]]+# ${marker}\$,\1: \3\"${newval}\"  # ${marker}," \
        "$file"
      echo "  generated ${marker}"
    else
      echo "  ${marker} already set, keeping"
    fi
  }

  echo "credentials:"
  _write_if_empty PG_PW       "$(openssl rand -hex 16)"
  _write_if_empty REDIS_PW    "$(openssl rand -hex 16)"
  _write_if_empty AUTH_SECRET "$(openssl rand -hex 32)"
}

# -------------------------------------------------------------------------
# scrub_passwords
#   Inverse of generate_passwords: replaces populated PG_PW / REDIS_PW /
#   AUTH_SECRET lines with the empty placeholder so the next install run
#   generates fresh values. YAML anchors are preserved.
# -------------------------------------------------------------------------
scrub_passwords() {
  local file=$1
  sed -i -E \
    's,^([[:space:]]+(password|authSecret)):[[:space:]]+(&[A-Za-z_][A-Za-z0-9_]*[[:space:]]+)?"[^"]+"([[:space:]]+# (PG_PW|REDIS_PW|AUTH_SECRET))$,\1: \3""\4,' \
    "$file"
}

# -------------------------------------------------------------------------
# do_install
#   Default action — ensure the namespace exists and run helm upgrade
#   --install. Idempotent.
# -------------------------------------------------------------------------
do_install() {
  generate_passwords "$VALUES_FILE"

  kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 \
    || kubectl create namespace "$NAMESPACE"

  # Everything (images, hosts, ALLOWED_ORIGINS, SERVED_DOMAINS, runtimeConfig,
  # password material, ...) lives in values.yaml. No --set.
  helm upgrade --install "$RELEASE" "$CHART_DIR" \
    --namespace "$NAMESPACE" \
    --wait --timeout 5m

  kubectl -n "$NAMESPACE" wait --for=condition=Ready pods --all --timeout=240s || true
  kubectl -n "$NAMESPACE" get pods,svc

  cat <<EOF

deploy complete.

  release:    $RELEASE
  namespace:  $NAMESPACE
  values:     $VALUES_FILE  (now contains generated passwords — do NOT commit)

next:
  kubectl -n $NAMESPACE port-forward svc/$RELEASE-ui 8080:80
  open http://localhost:8080

uninstall:
  bash $0 cleanup
EOF
}

# -------------------------------------------------------------------------
# do_cleanup
#   Tear down everything install.sh creates:
#     1. helm uninstall <release>
#     2. delete every PVC in the namespace (Bitnami charts leave these
#        around so a re-install with new generated passwords would fail
#        Postgres preflight; nuking them gives a clean slate)
#     3. delete the namespace
#     4. reset the password placeholders in values.yaml so the next
#        `install` regenerates them
# -------------------------------------------------------------------------
do_cleanup() {
  local confirm=${1:-}

  cat <<EOF
About to remove:
  - Helm release:  $RELEASE
  - PVCs in namespace $NAMESPACE (data is DESTROYED)
  - Namespace:     $NAMESPACE
  - Passwords in $VALUES_FILE will be reset to the empty placeholders

EOF
  if [ "$confirm" != "--yes" ]; then
    read -r -p "Continue? [yes/N] " answer
    case "$answer" in
      yes|YES|y|Y) ;;
      *) echo "aborted"; return 1 ;;
    esac
  fi

  if helm status "$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1; then
    echo "==> helm uninstall $RELEASE"
    helm uninstall "$RELEASE" -n "$NAMESPACE"
  else
    echo "==> helm release $RELEASE not found, skipping"
  fi

  if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
    echo "==> deleting PVCs in $NAMESPACE"
    kubectl -n "$NAMESPACE" delete pvc --all --wait=true --timeout=120s || true

    echo "==> deleting namespace $NAMESPACE"
    kubectl delete namespace "$NAMESPACE" --wait=true --timeout=120s || true
  else
    echo "==> namespace $NAMESPACE not found, skipping"
  fi

  echo "==> scrubbing passwords in $VALUES_FILE"
  scrub_passwords "$VALUES_FILE"

  echo "cleanup complete."
}

# -------------------------------------------------------------------------
# dispatch
# -------------------------------------------------------------------------
case "${1:-install}" in
  install|"")
    do_install
    ;;
  cleanup|uninstall|destroy)
    shift || true
    do_cleanup "${1:-}"
    ;;
  -h|--help|help)
    sed -n '1,20p' "$0"
    ;;
  *)
    echo "unknown command: $1" >&2
    echo "usage: $0 [install|cleanup [--yes]]" >&2
    exit 2
    ;;
esac
