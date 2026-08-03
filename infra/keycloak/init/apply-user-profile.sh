#!/bin/sh
# Post-import init for the bluedots realm: declare the signals user attributes
# and enable unmanaged attributes, via the Admin REST API.
#
# WHY THIS EXISTS: Keycloak 26 **ignores `kc.user.profile.config` from a realm
# import**. Verified on 26.5.5 — after importing
# `infra/keycloak/realms/bluedots-realm.json`, `GET /users/profile` reports no
# `unmanagedAttributePolicy` and declares only username/email/firstName/lastName.
#
# The consequence is silent and severe: writes of the `phoneNumber` attribute
# are DROPPED rather than rejected. A migrated phone-only user then has no
# phone attribute, the OTP authenticator (`otpChoice.phoneAttribute:
# phoneNumber`) cannot find a number to send a code to, and that user simply
# cannot log in — with nothing in any error log to say why.
#
# So the realm JSON is necessary but not sufficient. This must run after every
# Keycloak boot, before the user migration. It is idempotent.
#
# aggregator-dpg carries the same workaround at
# `aggregator-dpg/infra/keycloak/init/apply-user-profile.sh` (which also handles
# SMTP and its own client mappers). This is the signals-side minimum; when the
# shared realm's ownership moves into this repo, the two should merge.
#
# Requires: curl, jq.
set -eu

KC_URL="${KC_URL:-http://keycloak:8080}"
REALM="${KC_REALM:-bluedots}"
ADMIN_USER="${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}"
ADMIN_PASS="${KC_BOOTSTRAP_ADMIN_PASSWORD:-admin}"
POLICY="${UNMANAGED_POLICY:-ENABLED}"

echo "[kc-init] waiting for keycloak at ${KC_URL}..."
i=0
until curl -fsS "${KC_URL}/realms/master/.well-known/openid-configuration" > /dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "[kc-init] keycloak not reachable after 5min — aborting"
    exit 1
  fi
  sleep 5
done

TOKEN=$(curl -fsS -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=${ADMIN_USER}" \
  -d "password=${ADMIN_PASS}" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" | jq -r '.access_token // empty')

if [ -z "$TOKEN" ]; then
  echo "[kc-init] failed to obtain admin token"
  exit 1
fi

PROFILE=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/users/profile" \
  -H "Authorization: Bearer ${TOKEN}")

# Declare the two signals attributes explicitly, in addition to flipping the
# unmanaged policy. Declaring them is what makes them first-class (searchable
# via `q=phoneNumber:...`, which the migration's collision check relies on);
# the policy is the belt-and-braces for anything not declared.
# Two transformations:
#
#  1. Declare phoneNumber / phoneNumberVerified and enable unmanaged attributes,
#     so writes to them persist at all.
#
#  2. **Drop `required` from email, firstName and lastName.** Keycloak's default
#     profile marks all three required for the `user` role, which does not match
#     signals' data model: `user.email` is nullable and phone-only identities are
#     first-class, and a one-word name legitimately has no last name. With those
#     requirements in place the VERIFY_PROFILE required action fires on first
#     login and parks the user on "Update Account Information" — and filling in
#     the email does NOT clear it, because lastName is still missing. Relaxing
#     the profile is the fix; VERIFY_PROFILE stays enabled and simply has nothing
#     left to demand.
#
# `unique_by` keeps the first of each name, and the realm's existing entries
# come first — so an already-declared attribute keeps its own settings.
UPDATED=$(printf '%s' "$PROFILE" | jq --arg policy "$POLICY" '
  def relax:
    if (.name == "email" or .name == "firstName" or .name == "lastName")
    then del(.required)
    else . end;

  .unmanagedAttributePolicy = $policy
  | .attributes = (
      ((.attributes // []) + [
        {
          name: "phoneNumber",
          displayName: "Phone Number",
          permissions: { view: ["admin", "user"], edit: ["admin", "user"] },
          multivalued: false
        },
        {
          name: "phoneNumberVerified",
          displayName: "Phone Number Verified",
          permissions: { view: ["admin", "user"], edit: ["admin", "user"] },
          multivalued: false
        }
      ]) | unique_by(.name) | map(relax)
    )
  ')

HTTP=$(curl -s -o /tmp/kc-up-resp.json -w "%{http_code}" -X PUT \
  "${KC_URL}/admin/realms/${REALM}/users/profile" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data "${UPDATED}")

if [ "$HTTP" != "200" ]; then
  echo "[kc-init] user-profile PUT failed: HTTP ${HTTP}"
  cat /tmp/kc-up-resp.json || true
  exit 1
fi

# Verify rather than trust — this whole script exists because a write that
# looked fine did not take effect.
VERIFY=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/users/profile" \
  -H "Authorization: Bearer ${TOKEN}")
HAS_PHONE=$(printf '%s' "$VERIFY" | jq -r '[.attributes[]? | select(.name == "phoneNumber")] | length')
GOT_POLICY=$(printf '%s' "$VERIFY" | jq -r '.unmanagedAttributePolicy // "unset"')

STILL_REQUIRED=$(printf '%s' "$VERIFY" | jq -r '[.attributes[]? | select(.name == "email" or .name == "firstName" or .name == "lastName") | select(has("required")) | .name] | join(",")')

echo "[kc-init] unmanagedAttributePolicy=${GOT_POLICY} phoneNumber declared=${HAS_PHONE}"

if [ "${HAS_PHONE:-0}" -lt 1 ]; then
  echo "[kc-init] phoneNumber is still not declared — OTP login would silently fail"
  exit 1
fi

if [ -n "$STILL_REQUIRED" ]; then
  echo "[kc-init] still required for role user: ${STILL_REQUIRED}"
  echo "[kc-init] phone-only users and one-word names would be parked on the"
  echo "[kc-init] 'Update Account Information' screen at first login"
  exit 1
fi
echo "[kc-init] email/firstName/lastName optional — phone-only login is viable"

echo "[kc-init] user profile ready."

# ────────────────────────────────────────────────────────────────────────────
# Acting-org claim mappers (§5.1 of the migration design)
#
# Same reason as everything else in this script: the realm JSON is only consulted
# on FIRST import, so a realm that already exists in Keycloak's database never
# picks up newly-added protocol mappers. Re-applied here idempotently.
#
# The claim is `signals_acting_orgs` — the set of signals org ids a caller may
# assert via `x-acting-org-id`. `signals-api` deliberately gets none: it is the
# admin/provisioning client, not an acting-org caller.
# ────────────────────────────────────────────────────────────────────────────

ensure_acting_org_mapper() {
  target_client="$1"
  mapper_json="$2"

  client_uuid=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients?clientId=${target_client}" \
    -H "Authorization: Bearer ${TOKEN}" | jq -r '.[0].id // empty')

  if [ -z "$client_uuid" ]; then
    echo "[kc-init] client '${target_client}' not found — skipping acting-org mapper"
    return 0
  fi

  existing=$(curl -fsS \
    "${KC_URL}/admin/realms/${REALM}/clients/${client_uuid}/protocol-mappers/models" \
    -H "Authorization: Bearer ${TOKEN}" \
    | jq -r '[.[] | select(.name == "signals_acting_orgs")] | length')

  if [ "${existing:-0}" -gt 0 ]; then
    echo "[kc-init] ${target_client}: signals_acting_orgs mapper already present — skip"
    return 0
  fi

  http=$(curl -s -o /tmp/kc-mapper-resp.json -w "%{http_code}" -X POST \
    "${KC_URL}/admin/realms/${REALM}/clients/${client_uuid}/protocol-mappers/models" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    --data "${mapper_json}")

  if [ "$http" = "201" ]; then
    echo "[kc-init] ${target_client}: signals_acting_orgs mapper created"
  else
    echo "[kc-init] ${target_client}: mapper create FAILED: HTTP ${http}"
    cat /tmp/kc-mapper-resp.json || true
    return 1
  fi
}

# Human tokens: read the org from the same `signalstack_org_id` user attribute
# aggregator's approval flow already populates. Inert for a signals participant,
# who has no such attribute — the claim is simply omitted.
ensure_acting_org_mapper signals-ui '{
  "name": "signals_acting_orgs",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-usermodel-attribute-mapper",
  "consentRequired": false,
  "config": {
    "user.attribute": "signalstack_org_id",
    "claim.name": "signals_acting_orgs",
    "jsonType.label": "String",
    "id.token.claim": "false",
    "access.token.claim": "true",
    "userinfo.token.claim": "false",
    "multivalued": "false",
    "aggregate.attrs": "false"
  }
}'

# Service clients: a wildcard grant, preserving today's platform-wide reach for
# the integrating DPGs as an explicit, auditable grant. TODO(§5.1): replace with
# an enumerated org list once the set each DPG legitimately serves is known.
for svc in aggregator-dpg voice-dpg; do
  ensure_acting_org_mapper "$svc" '{
    "name": "signals_acting_orgs",
    "protocol": "openid-connect",
    "protocolMapper": "oidc-hardcoded-claim-mapper",
    "consentRequired": false,
    "config": {
      "claim.name": "signals_acting_orgs",
      "claim.value": "*",
      "jsonType.label": "String",
      "id.token.claim": "false",
      "access.token.claim": "true",
      "access.tokenResponse.claim": "false"
    }
  }'
done

echo "[kc-init] acting-org claim mappers ready."
