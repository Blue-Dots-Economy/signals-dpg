-- SS-3 (#640) — audit the default-aggregator change from the database.
--
-- Nominating the default is a "direct backend/support request" (product's
-- answer on #640): an operator runs
--
--   UPDATE organization SET default_for_bindings = ARRAY['blue_dot/seeker']
--    WHERE id = '<org id>';
--
-- There is no API in front of it, so the audit trail cannot live in an
-- application route. This trigger records it wherever the write comes from,
-- including psql — which is the point: `organization` has no `updated_at`, and
-- this column decides which organisation may decrypt an entire inbound
-- population's PII, so a change with no trace would be unauditable.
--
-- One row per binding gained or lost:
--   to_org_id   NULL => the binding was REVOKED (nothing took over)
--   from_org_id NULL => first assignment for that binding
--
-- `changed_by` is the Postgres role that ran the statement (`session_user`),
-- which is the only identity available for a hand-written UPDATE.
--
-- Custom migration: triggers are not expressible in the drizzle schema, so per
-- apps/api/drizzle/README.md this is hand-written rather than generated.

CREATE OR REPLACE FUNCTION log_default_aggregator_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  binding text;
BEGIN
  -- Bindings gained.
  FOR binding IN
    SELECT unnest(coalesce(NEW.default_for_bindings, '{}'::text[]))
    EXCEPT
    SELECT unnest(coalesce(OLD.default_for_bindings, '{}'::text[]))
  LOOP
    INSERT INTO aggregator_default_audit (binding, from_org_id, to_org_id, changed_by)
    VALUES (binding, NULL, NEW.id, session_user);
  END LOOP;

  -- Bindings lost.
  FOR binding IN
    SELECT unnest(coalesce(OLD.default_for_bindings, '{}'::text[]))
    EXCEPT
    SELECT unnest(coalesce(NEW.default_for_bindings, '{}'::text[]))
  LOOP
    INSERT INTO aggregator_default_audit (binding, from_org_id, to_org_id, changed_by)
    VALUES (binding, OLD.id, NULL, session_user);
  END LOOP;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Row-level AFTER UPDATE, and only when the column actually changed, so an
-- unrelated org update (the /aggregator/upsert mirror rewrites name/logo/
-- metadata on every sync) writes no audit rows.
DROP TRIGGER IF EXISTS organization_default_aggregator_audit ON organization;
--> statement-breakpoint
CREATE TRIGGER organization_default_aggregator_audit
AFTER UPDATE OF default_for_bindings ON organization
FOR EACH ROW
WHEN (
  coalesce(OLD.default_for_bindings, '{}'::text[])
    IS DISTINCT FROM coalesce(NEW.default_for_bindings, '{}'::text[])
)
EXECUTE FUNCTION log_default_aggregator_change();
