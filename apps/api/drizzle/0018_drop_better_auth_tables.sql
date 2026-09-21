-- #517: drop the five better-auth tables nothing uses.
--
-- All five were empty in every environment checked, had zero references in
-- application code, and had zero INBOUND foreign keys (their own FKs point out
-- at `user`/`organization`, which is why CASCADE is a formality here rather
-- than a risk).
--
--   account       better-auth's credential store. Signals never wrote it: OTP
--                 login needs no password row, and credentials live in Keycloak
--                 now. Its last reader was `migrate_users_to_keycloak
--                 --audit-passwords` (Risk R6), removed in the same commit —
--                 that audit ran BEFORE a cutover, on code that still had
--                 better-auth, so it cannot fire on a build where better-auth
--                 is already gone.
--   verification  better-auth's single-use token table. Unused here: the OTP
--                 flow stored codes in Redis via `secondaryStorage`, not SQL.
--   invitation    \
--   team           }  better-auth `organization`-plugin tables. The plugin is
--   team_member   /   gone; signals models org membership with `member` alone.
--
-- NOT dropped, deliberately: `apikey`. It is a cross-repo contract (signals'
-- own verifier, signals-search's SQL in another repo, and the automation's
-- `provision_service_users.sql` seeding) and retiring it is blocked on #516.
-- `user`, `organization` and `member` are domain tables that merely originated
-- with better-auth.

DROP TABLE "account" CASCADE;--> statement-breakpoint
DROP TABLE "invitation" CASCADE;--> statement-breakpoint
DROP TABLE "team" CASCADE;--> statement-breakpoint
DROP TABLE "team_member" CASCADE;--> statement-breakpoint
DROP TABLE "verification" CASCADE;