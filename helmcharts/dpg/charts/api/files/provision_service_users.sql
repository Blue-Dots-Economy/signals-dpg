-- helmcharts/dpg/charts/api/files/provision_service_users.sql
--
-- Idempotent upsert for integrating-DPG service users / apikeys. Applied
-- by the helm migrate-job AFTER schema.sql, on every install AND upgrade
-- (unlike schema.sql which short-circuits when `items` already exists).
--
-- Source of truth for the raw key is the k8s Secret holding
-- AGGREGATOR_DPG_API_KEY; this file derives the SHA-256(key) hash that
-- better-auth's @better-auth/api-key looks up at verify time. Re-running
-- with a rotated key UPDATEs the row in place — old key stops working
-- immediately.
--
-- Required psql variable:  aggregator_dpg_api_key
-- Invoked from migrate-job.yaml as:
--   psql -v aggregator_dpg_api_key="$AGGREGATOR_DPG_API_KEY" -f /sql/provision_service_users.sql
--
-- Requires pgcrypto (digest, gen_random_uuid) — migrate-job already
-- enables it during the DDL step.
--
-- Hash format must match @better-auth/api-key `defaultKeyHasher`:
--   base64url(sha256(raw_key))  — unpadded, '+/' → '-_'.

\set ON_ERROR_STOP on

DO $$
DECLARE
  _raw_key      text := :'aggregator_dpg_api_key';
  _hashed       text;
  _org_slug     text := 'aggregator-dpg';
  _user_email   text := 'aggregator-dpg-svc@signals.local';
  _key_prefix   text := 'sk_signals_';
  _org_id       text;
  _user_id      text;
  _existing_key text;
BEGIN
  IF _raw_key IS NULL OR _raw_key = '' THEN
    RAISE EXCEPTION 'aggregator_dpg_api_key psql variable is not set';
  END IF;
  IF length(_raw_key) < 32 THEN
    RAISE EXCEPTION 'aggregator_dpg_api_key is too short (% chars); need >= 32', length(_raw_key);
  END IF;

  _hashed := translate(
    rtrim(encode(digest(_raw_key, 'sha256'), 'base64'), '='),
    '+/', '-_'
  );

  -- 1. organization (match by slug)
  SELECT id INTO _org_id FROM "organization" WHERE slug = _org_slug;
  IF _org_id IS NULL THEN
    _org_id := 'org_' || gen_random_uuid();
    INSERT INTO "organization" (id, slug, name, type, created_at)
    VALUES (_org_id, _org_slug, _org_slug || ' (network service)', 'network_service', now());
  END IF;

  -- 2. user (match by email)
  SELECT id INTO _user_id FROM "user" WHERE email = _user_email;
  IF _user_id IS NULL THEN
    _user_id := 'usr_' || gen_random_uuid();
    INSERT INTO "user" (id, email, name, email_verified, created_at, updated_at)
    VALUES (_user_id, _user_email, _org_slug, true, now(), now());
  END IF;

  -- 3. member (match by user_id + organization_id)
  IF NOT EXISTS (
    SELECT 1 FROM "member"
    WHERE user_id = _user_id AND organization_id = _org_id
  ) THEN
    INSERT INTO "member" (id, user_id, organization_id, role, created_at)
    VALUES ('mem_' || gen_random_uuid(), _user_id, _org_id, 'service', now());
  END IF;

  -- 4. apikey (one per service user). Rotation = hash differs → UPDATE in place.
  SELECT key INTO _existing_key FROM "apikey" WHERE user_id = _user_id LIMIT 1;
  IF _existing_key IS NULL THEN
    INSERT INTO "apikey" (
      id, config_id, name, start, reference_id, prefix, key, user_id,
      enabled, rate_limit_enabled, created_at, updated_at
    )
    VALUES (
      'key_' || gen_random_uuid(),
      'default',
      _org_slug,
      substring(_raw_key from 1 for 6),
      _user_id,
      _key_prefix,
      _hashed,
      _user_id,
      true,
      false,
      now(),
      now()
    );
  ELSIF _existing_key <> _hashed THEN
    UPDATE "apikey"
       SET key = _hashed,
           start = substring(_raw_key from 1 for 6),
           prefix = _key_prefix,
           enabled = true,
           updated_at = now()
     WHERE user_id = _user_id;
  END IF;
END
$$;
