-- SS-3 (#640) — two triggers on organization.default_for_bindings.
--
-- The default aggregator is nominated by a "direct backend/support request"
-- (product's answer on #640): a hand-written UPDATE, no API. So both the
-- exclusivity rule and the audit trail have to live in the database — an
-- application route would never see the write.
--
-- Custom migration: triggers are not expressible in the drizzle schema, so per
-- apps/api/drizzle/README.md this is hand-written rather than generated.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Exclusivity: no two orgs may be the default for the SAME binding.
--
-- Different aggregators MAY be defaults for different bindings, and that is
-- the expected shape: a user holds exactly one domain (the single-role lock in
-- create_item.ts keeps user.domains at one entry and never grows it), so a
-- seeker aggregator and a provider aggregator can coexist and each owns its own
-- self-signup population.
--
-- What must never happen is two orgs claiming the same binding: the tag this
-- drives (user.onboarded_by_org_id) has one slot per account, and
-- participant_decrypt scopes on it, so a contested binding would hand PII
-- decrypt rights to whichever row a query happened to return first.
--
-- Postgres cannot unique-index an array *element*, and there is no gist opclass
-- for text[] overlap, so this is a trigger rather than a constraint. The
-- advisory lock makes it safe against two concurrent nominations, which would
-- otherwise each see a clear field and both commit.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION assert_default_binding_exclusive()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  clash_id   text;
  clash_bind text;
BEGIN
  IF NEW.default_for_bindings IS NULL OR cardinality(NEW.default_for_bindings) = 0 THEN
    RETURN NEW;
  END IF;

  -- Serialise nominations so two concurrent writers cannot both pass the check.
  PERFORM pg_advisory_xact_lock(hashtext('organization.default_for_bindings'));

  SELECT o.id, b
    INTO clash_id, clash_bind
    FROM organization o
    CROSS JOIN LATERAL unnest(o.default_for_bindings) AS b
   WHERE o.id <> NEW.id
     AND b = ANY (NEW.default_for_bindings)
   LIMIT 1;

  IF clash_id IS NOT NULL THEN
    RAISE EXCEPTION
      'binding % is already the default of org % — clear it there first',
      clash_bind, clash_id
      USING ERRCODE = 'unique_violation';
  END IF;

  -- The org must actually report on the domain it is being made default for.
  --
  -- Dropping the old admin endpoint took two validations with it that the
  -- database had not replaced: this one, and "is the binding served by this
  -- instance" (which the DB cannot know — SERVED_DOMAINS is env config). This
  -- restores the one that is checkable, and it doubles as a typo guard: a
  -- fat-fingered 'blue_dot/seekers' matches no declared domain and is
  -- rejected, where before it would have been accepted silently, tagged
  -- nobody, and still produced an audit row reading like a success.
  --
  -- Skipped when the org declares nothing (legacy mirrors predate
  -- metadata.domains), so this cannot lock out an existing deployment.
  IF coalesce(jsonb_array_length((NEW.metadata::jsonb) -> 'domains'), 0) > 0 THEN
    SELECT b
      INTO clash_bind
      FROM unnest(NEW.default_for_bindings) AS b
     WHERE split_part(b, '/', 2) NOT IN (
             SELECT jsonb_array_elements_text((NEW.metadata::jsonb) -> 'domains'))
     LIMIT 1;

    IF clash_bind IS NOT NULL THEN
      RAISE EXCEPTION
        'org % does not declare the domain in binding % (declares: %)',
        NEW.id, clash_bind,
        (SELECT string_agg(d, ',')
           FROM jsonb_array_elements_text((NEW.metadata::jsonb) -> 'domains') AS d)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS organization_default_binding_exclusive ON organization;
--> statement-breakpoint
CREATE TRIGGER organization_default_binding_exclusive
BEFORE INSERT OR UPDATE OF default_for_bindings ON organization
FOR EACH ROW
EXECUTE FUNCTION assert_default_binding_exclusive();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Audit: one row per binding gained or lost.
--
--   to_org_id   NULL => the binding was REVOKED (nothing took over)
--   from_org_id NULL => nothing held it immediately before this row
--
-- A hand-over is two rows (a revoke of A, then a grant to B) because
-- exclusivity forces clearing A first, so the grant row looks exactly like a
-- first-ever nomination. Run both UPDATEs in ONE transaction and the pair
-- shares a changed_at, which is how an operator correlates them.
--
-- `changed_by` is the Postgres role that ran the statement, the only identity
-- available for a hand-written UPDATE. `organization` has no `updated_at`, and
-- this column decides which organisation may decrypt an inbound population's
-- PII, so a change with no trace would be unauditable.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION log_default_aggregator_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  binding text;
BEGIN
  FOR binding IN
    SELECT unnest(coalesce(NEW.default_for_bindings, '{}'::text[]))
    EXCEPT
    SELECT unnest(coalesce(OLD.default_for_bindings, '{}'::text[]))
  LOOP
    INSERT INTO aggregator_default_audit (binding, from_org_id, to_org_id, changed_by)
    VALUES (binding, NULL, NEW.id, session_user);
  END LOOP;

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

-- Scoped to the column, and only when it actually changed, so the
-- /aggregator/upsert mirror rewriting name/logo/metadata writes no audit rows.
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
