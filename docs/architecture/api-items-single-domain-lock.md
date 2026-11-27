# Single-domain lock

Code: `apps/api/src/services/items/single_domain_lock.ts` (`claimDomain`, `readLockedDomains`), used by `assertSingleDomain` in `apps/api/src/services/item_service.ts` and by `POST /api/v1/user/domains` (`apps/api/src/routes/v1/user/user_domains.ts`).

## Why an account holds exactly one domain

`user.onboarded_by_org_id` is the tenancy key that decides which aggregator org may decrypt a participant's PII. It is per account and write-once, while items are per domain. An account spanning two domains would have one owner covering both, letting one domain's default aggregator decrypt the other domain's participant. Keeping every account to one domain is what allows a different default aggregator per domain.

Two places decide an account's domain (every item create, and the explicit pick at signup), so both import the same implementation. Separate copies of the SQL previously drifted and let an account gain a second domain.

## Why `claimDomain` has two guards

- `cardinality(domains) = 0` makes the claim write-once at the database level, so moving someone between domains stays an explicit support operation. It also makes concurrency safe without an advisory lock: a second caller blocks on the row lock, re-evaluates its WHERE against the committed value, matches nothing, and falls through to `readLockedDomains`.
- `NOT EXISTS items` keeps the lock correct where `user.domains` is empty but the account already owns items: a database not yet backfilled by migration 0015 (the migration runs as a Helm post-install/post-upgrade hook, so pods serve traffic first), legacy `POST /admin/participant` participants, and accounts after the documented support reset (`UPDATE "user" SET domains='{}'`). Without it such an account could claim a second domain and read as locked to the wrong one, a state 0015 cannot repair because it only fills empty columns.

## Why `readLockedDomains` falls back to items

`user.domains` is a cache; the domains of the items an account owns are the source of truth. The fallback runs only when the column is empty, which after migration 0015 means a brand-new account with no items, so it costs a couple of index probes (`items` is LIST-partitioned on `item_network`, each partition carrying `items_created_by_idx`).

More than one domain is returned only for a legacy account that held items in two domains before the lock existed; callers honour both, so the rule stops new multi-domain accounts without breaking old ones.

## Known limit: the key is the bare domain

`user.domains` stores a bare domain while `organization.default_for_bindings` is per `<network>/<domain>`. On an instance serving two networks that declare the same domain (e.g. `blue_dot` and `purple_dot` both declaring `seeker`), those are one lock slot but two tenancies, so the lock does not stop an account holding both. No deployment serves such a pair today. Fixing it means storing `network/domain` in the lock, or scoping aggregator read paths to the networks of the org's own bindings.
