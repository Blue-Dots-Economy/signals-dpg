-- Backfill `user.domains` from the items each user actually owns.
--
-- The single-domain lock (`assertSingleDomain` in `services/item_service.ts`)
-- reads `user.domains`, and treats an empty column as "not decided yet — allow
-- any served domain". That is correct for a brand-new account and wrong for
-- everyone already in the database: `POST /api/v1/admin/participant` never
-- wrote the column, so every aggregator- and voice-onboarded participant has
-- `{}` no matter how many profiles they hold. Shipping the lock without this
-- backfill would leave it inert for exactly the population it exists to
-- constrain.
--
-- Only fills rows that are empty. A user whose domain was recorded at signup
-- (`applySignupExtras`) or on a first create is already authoritative and is
-- left alone — this must never re-point an existing lock.
--
-- Custom migration: data, not schema. Nothing here is expressible in
-- `db/postgres/schema/*.ts`, so per `apps/api/drizzle/README.md` it is
-- hand-written rather than generated.
--
-- Deliberately NOT filtered to one network. `user.domains` stores a bare domain
-- with no network qualifier, and an instance may serve several networks, so the
-- authoritative answer is "every domain this user has items in" regardless of
-- network. `items` is LIST-partitioned on `item_network`, so this reads every
-- partition once — acceptable for a one-shot migration, and the grouping is on
-- the `items_created_by_idx` leading column.
--
-- Multi-domain users: a user with items in two domains gets BOTH recorded.
-- `assertSingleDomain` allows any domain already in the array, so such a user
-- keeps working exactly as today and is not retroactively broken by a rule that
-- did not exist when their profiles were created. They are also the population
-- that made a global single-default necessary in the first place, so find them
-- before nominating a second default aggregator:
--
--   SELECT id, domains FROM "user" WHERE cardinality(domains) > 1;
--
-- Going forward the lock prevents new ones.
UPDATE "user" u
   SET domains = sub.domains,
       updated_at = now()
  FROM (
    SELECT created_by, array_agg(DISTINCT item_domain) AS domains
      FROM items
     GROUP BY created_by
  ) sub
 WHERE u.id = sub.created_by
   AND (u.domains IS NULL OR cardinality(u.domains) = 0);
