# Participant decrypt: ownership and domain scope

Describes `scopeConditions` in `apps/api/src/routes/v1/admin/participant_decrypt.ts` (`POST /api/v1/admin/participant/decrypt`).

## Ownership

Ownership is keyed on the item creator's `user.onboarded_by_org_id` (joined via `items.created_by`), never on `item_metrics`. `item_metrics` is a lazily materialised analytics cache, filled only when an aggregator views its dashboard or export, so keying on it would silently drop items that were never dashboarded.

- aggregator: only items whose creator it onboarded, and only in the domains it declares.
- network_service: every item in the networks this instance serves.

## Why the domain filter as well

`user.onboarded_by_org_id` is per account, while items and default aggregators are per domain. If an account ever spanned two domains with different default aggregators, one domain's default could decrypt the other's participant. The single-domain lock (`claimDomain` in `services/items/single_domain_lock.ts`) prevents such accounts going forward, but legacy rows that predate the lock can still hold two domains. Filtering on the org's declared domains means a leak needs both invariants to fail.

The scope source is the org's `metadata.domains`, the same source `aggregator/dashboard.ts` and `aggregator/export.ts` use, so an aggregator decrypts exactly the populations it reports on. An aggregator with no declared domains is refused with `400 NO_DOMAINS_CONFIGURED` rather than defaulting to all domains.

## Consequence: access follows metadata edits

Ownership is historical (`onboarded_by_org_id` is only written while it is null), but the domain scope is read live. `POST /api/v1/admin/aggregator/upsert` rewrites `metadata` wholesale on every sync from aggregator-dpg, so a sync that drops a domain also revokes decrypt for that domain's previously onboarded participants. This is accepted because dashboard and export already behave the same way; pinning scope at onboarding time would need a per-profile ownership record.
