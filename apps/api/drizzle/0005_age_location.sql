-- #331: replace user.date_of_birth with an age snapshot (+ empty location).
-- Add the new columns first, backfill age from any existing DOB, then drop the
-- old column — so populated birth dates aren't lost (mirrors the client rule
-- age = currentYear - birthYear). Custom SQL in the ledger has precedent
-- (0003_legacy_column_backfill.sql).
--
-- Idempotent: the add/drop use IF [NOT] EXISTS and the backfill + drop are
-- guarded on date_of_birth still existing, so re-running (or a DB that never
-- had the column) is a safe no-op rather than an error.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "age" integer;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "location" text;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user' AND column_name = 'date_of_birth'
  ) THEN
    UPDATE "user"
      SET "age" = EXTRACT(YEAR FROM CURRENT_DATE)::int - EXTRACT(YEAR FROM "date_of_birth")::int
      WHERE "date_of_birth" IS NOT NULL AND "age" IS NULL;
    ALTER TABLE "user" DROP COLUMN "date_of_birth";
  END IF;
END $$;
