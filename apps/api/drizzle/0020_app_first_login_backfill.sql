-- Custom migration (data only, no schema change): mark every user that exists
-- today as having already logged in to the app, so the "first login" welcome
-- (user.tags.app_first_login_at, see apps/api/src/services/auth/app_first_login.ts)
-- only ever goes to people who have never used it. Existing users get their
-- account creation time; idempotent — a user who already has the key is left
-- alone, so re-applying changes nothing.
UPDATE "user"
   SET "tags" = "tags" || jsonb_build_object('app_first_login_at', to_jsonb(COALESCE("created_at", now())))
 WHERE NOT ("tags" ? 'app_first_login_at');
