#!/bin/sh
# Post-import init: the `signals-sso` identity provider (partner-portal SSO).
#
# WHY THIS EXISTS: the realm JSON is only read on FIRST import. A realm that
# already exists in Keycloak's database never picks up the identity provider,
# its mappers, the first-login flow or the redirector step in the browser flow.
# This applies all four via the Admin REST API. Idempotent: safe after every
# boot, and it re-syncs the provider's URLs and secret each time.
#
# What it sets up (see docs/superpowers/specs/2026-09-24-external-idp-bridge-ncs-sso-design.md §7):
#   1. flow `signals-sso-first-login`: create the user, or link to the
#      account the Signals SSO API named in `preferred_username` — no screens
#   2. `identity-provider-redirector` as the FIRST step of the browser flow, so
#      `kc_idp_hint=signals-sso` goes straight to the SSO API. First, not after
#      `auth-cookie`: otherwise a leftover SSO session in the browser would log
#      in its previous owner instead of the partner user.
#   3. the `signals-sso` OIDC identity provider (the API's /api/v1/auth/sso/oidc)
#   4. its mappers: username, phoneNumber(+Verified), sso_provider, and the
#      signals_participant role signals requires on every human token
#
# Requires: curl, jq.
set -eu

KC_URL="${KC_URL:-http://keycloak:8080}"
REALM="${KC_REALM:-bluedots}"
ADMIN_USER="${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}"
ADMIN_PASS="${KC_BOOTSTRAP_ADMIN_PASSWORD:-admin}"
: "${API_BASE_URL:?API_BASE_URL must be set (browser-facing signals API base URL)}"
: "${SSO_API_INTERNAL_BASE_URL:=$API_BASE_URL}"
: "${SSO_OIDC_CLIENT_SECRET:=sso-not-configured}"
: "${SSO_OIDC_CLIENT_ID:=signals-sso}"

ALIAS="signals-sso"
BROWSER_FLOW="${BROWSER_FLOW:-bluedots-otp-browser}"
A="${KC_URL}/admin/realms/${REALM}"

TOKEN=$(curl -fsS -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=${ADMIN_USER}" -d "password=${ADMIN_PASS}" \
  -d "grant_type=password" -d "client_id=admin-cli" | jq -r '.access_token // empty')
[ -n "$TOKEN" ] || { echo "[kc-sso] failed to obtain admin token"; exit 1; }

api() { # api METHOD PATH [JSON] -> body on stdout; fails on HTTP >= 400
  method="$1"; path="$2"; body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "${A}${path}" -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" --data "$body"
  else
    curl -fsS -X "$method" "${A}${path}" -H "Authorization: Bearer ${TOKEN}"
  fi
}

status() { # status PATH -> HTTP code of a GET
  curl -s -o /dev/null -w "%{http_code}" "${A}$1" -H "Authorization: Bearer ${TOKEN}"
}

set_requirement() { # set_requirement FLOW PROVIDER_OR_DISPLAY REQUIREMENT
  flow="$1"; match="$2"; req="$3"
  exec_json=$(api GET "/authentication/flows/${flow}/executions" \
    | jq -c --arg m "$match" '[.[] | select(.providerId == $m or .displayName == $m)][0]')
  [ "$exec_json" != "null" ] || { echo "[kc-sso] ${flow}: ${match} not found"; exit 1; }
  api PUT "/authentication/flows/${flow}/executions" \
    "$(printf '%s' "$exec_json" | jq -c --arg r "$req" '.requirement = $r')" >/dev/null
}

# ── 1. first-login flow ─────────────────────────────────────────────────────
# Keycloak's documented auto-link shape: "Create User If Unique" and
# "Automatically Set Existing User", both ALTERNATIVE. No "Detect Existing
# Broker User" step: once create-if-unique has recorded the existing account it
# returns `attempted`, which fails a REQUIRED step and the whole login.
if [ "$(status /authentication/flows/signals-sso-first-login/executions)" = "404" ]; then
  api POST /authentication/flows '{"alias":"signals-sso-first-login","providerId":"basic-flow","topLevel":true,"builtIn":false,"description":"Partner SSO first login: create the user, or link to the existing account whose username the Signals SSO API asserted. No screens."}' >/dev/null
  echo "[kc-sso] created flow signals-sso-first-login"
else
  echo "[kc-sso] flow signals-sso-first-login already present"
fi
# Migrate the earlier shape (a detect + auto-link sub-flow) if it is there.
old_sub=$(api GET /authentication/flows/signals-sso-first-login/executions \
  | jq -r '.[] | select(.displayName == "signals-sso-auto-link" and .level == 0) | .id')
if [ -n "$old_sub" ]; then
  api DELETE "/authentication/executions/${old_sub}" >/dev/null
  echo "[kc-sso] removed the old signals-sso-auto-link sub-flow"
fi
for provider in idp-create-user-if-unique idp-auto-link; do
  present=$(api GET /authentication/flows/signals-sso-first-login/executions \
    | jq --arg p "$provider" '[.[] | select(.providerId == $p and .level == 0)] | length')
  if [ "$present" -eq 0 ]; then
    api POST /authentication/flows/signals-sso-first-login/executions/execution \
      "{\"provider\":\"${provider}\"}" >/dev/null
  fi
  set_requirement signals-sso-first-login "$provider" ALTERNATIVE
done

# ── 2. redirector first in the browser flow ─────────────────────────────────
has_redirector=$(api GET "/authentication/flows/${BROWSER_FLOW}/executions" \
  | jq '[.[] | select(.providerId == "identity-provider-redirector")] | length')
if [ "$has_redirector" -eq 0 ]; then
  api POST "/authentication/flows/${BROWSER_FLOW}/executions/execution" '{"provider":"identity-provider-redirector"}' >/dev/null
  echo "[kc-sso] added identity-provider-redirector to ${BROWSER_FLOW}"
fi
set_requirement "$BROWSER_FLOW" identity-provider-redirector ALTERNATIVE
# Raise it until it is the first top-level step.
i=0
while :; do
  first=$(api GET "/authentication/flows/${BROWSER_FLOW}/executions" \
    | jq -r '[.[] | select(.level == 0)] | sort_by(.index) | .[0].providerId // ""')
  [ "$first" = "identity-provider-redirector" ] && break
  i=$((i + 1)); [ "$i" -le 10 ] || { echo "[kc-sso] could not move the redirector first"; exit 1; }
  id=$(api GET "/authentication/flows/${BROWSER_FLOW}/executions" \
    | jq -r '.[] | select(.providerId == "identity-provider-redirector") | .id')
  api POST "/authentication/executions/${id}/raise-priority" >/dev/null
done
echo "[kc-sso] ${BROWSER_FLOW}: identity-provider-redirector is first"

# ── 3. identity provider ────────────────────────────────────────────────────
IDP=$(jq -n \
  --arg alias "$ALIAS" \
  --arg issuer "${API_BASE_URL}/api/v1/auth/sso/oidc" \
  --arg internal "${SSO_API_INTERNAL_BASE_URL}/api/v1/auth/sso/oidc" \
  --arg clientId "$SSO_OIDC_CLIENT_ID" \
  --arg secret "$SSO_OIDC_CLIENT_SECRET" '{
  alias: $alias, displayName: "Partner SSO", providerId: "oidc", enabled: true,
  trustEmail: false, storeToken: false, addReadTokenRoleOnCreate: false, linkOnly: false,
  hideOnLogin: true, firstBrokerLoginFlowAlias: "signals-sso-first-login",
  updateProfileFirstLoginMode: "off",
  config: {
    issuer: $issuer,
    authorizationUrl: ($issuer + "/authorize"),
    tokenUrl: ($internal + "/token"),
    jwksUrl: ($internal + "/jwks"),
    useJwksUrl: "true", validateSignature: "true",
    clientId: $clientId, clientSecret: $secret, clientAuthMethod: "client_secret_post",
    defaultScope: "openid", syncMode: "IMPORT", disableUserInfo: "true",
    pkceEnabled: "false", hideOnLoginPage: "true", backchannelSupported: "false",
    sendIdTokenOnLogout: "false", disableNonce: "false"
  }}')

if [ "$(status "/identity-provider/instances/${ALIAS}")" = "404" ]; then
  api POST /identity-provider/instances "$IDP" >/dev/null
  echo "[kc-sso] created identity provider ${ALIAS}"
else
  api PUT "/identity-provider/instances/${ALIAS}" "$IDP" >/dev/null
  echo "[kc-sso] updated identity provider ${ALIAS}"
fi

# ── 4. mappers ──────────────────────────────────────────────────────────────
ensure_mapper() { # ensure_mapper NAME TYPE CONFIG_JSON
  name="$1"; type="$2"; config="$3"
  existing=$(api GET "/identity-provider/instances/${ALIAS}/mappers" \
    | jq -c --arg n "$name" '[.[] | select(.name == $n)][0]')
  if [ "$existing" != "null" ]; then
    # Same name but a different mapper type is a broken mapper (Keycloak fails
    # every broker login with a NullPointerException on an unknown type), so
    # replace it rather than skipping it.
    [ "$(printf '%s' "$existing" | jq -r '.identityProviderMapper')" = "$type" ] && return 0
    api DELETE "/identity-provider/instances/${ALIAS}/mappers/$(printf '%s' "$existing" | jq -r '.id')" >/dev/null
    echo "[kc-sso] mapper ${name} had the wrong type — replacing"
  fi
  api POST "/identity-provider/instances/${ALIAS}/mappers" "$(jq -n \
    --arg n "$name" --arg t "$type" --arg a "$ALIAS" --argjson c "$config" \
    '{name: $n, identityProviderAlias: $a, identityProviderMapper: $t, config: $c}')" >/dev/null
  echo "[kc-sso] mapper ${name} created"
}

ensure_mapper "username from SSO API" oidc-username-idp-mapper \
  '{"syncMode":"IMPORT","template":"${CLAIM.preferred_username}","target":"LOCAL"}'
ensure_mapper phoneNumber oidc-user-attribute-idp-mapper \
  '{"syncMode":"IMPORT","claim":"phone_number","user.attribute":"phoneNumber"}'
ensure_mapper phoneNumberVerified oidc-user-attribute-idp-mapper \
  '{"syncMode":"IMPORT","claim":"phone_number_verified","user.attribute":"phoneNumberVerified"}'
ensure_mapper sso_provider oidc-user-attribute-idp-mapper \
  '{"syncMode":"IMPORT","claim":"sso_provider","user.attribute":"sso_provider"}'
ensure_mapper "signals_participant role" oidc-hardcoded-role-idp-mapper \
  '{"syncMode":"INHERIT","role":"signals_participant"}'

echo "[kc-sso] signals-sso identity provider ready."
