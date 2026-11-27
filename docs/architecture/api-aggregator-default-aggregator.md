# Default aggregator tagging

Code: `apps/api/src/services/aggregator/default_aggregator.ts`; migrations `0013`, `0014`, `0016` in `apps/api/drizzle/`.

## Why it exists

A user arriving through an uncontrolled inbound path (portal self-signup, or a cold call to the network-hosted voice agent) has no aggregator of their own. `user.onboarded_by_org_id` is the tenancy key for participant reads, action authorisation and PII decryption, so leaving it null means nobody is responsible for verifying that person and nobody can decrypt them.

The default aggregator is a real, already-approved aggregator org that the network admin nominates through a backend/support request: a hand-written UPDATE of `organization.default_for_bindings`. There is no API for it. The database enforces the rules: a CHECK that the org is `type='aggregator'` (0013), a trigger for per-binding exclusivity that also rejects a binding whose domain the org does not declare, and an audit trigger (0014).

It is never system-generated: a system-minted org has no enabled Keycloak user, so the unverified queue it owns would be one nobody can open. The database can only prove `type = 'aggregator'`; `organization` has no approval column, so "already approved" is a runbook guarantee, not an enforced one.

## Resolution is per binding

`default_for_bindings` is per `<network>/<domain>`, and lookups are per binding. One aggregator may hold several bindings, and different aggregators may hold one binding each. Postgres cannot unique-index an array element, so per-binding exclusivity is the `organization_default_binding_exclusive` trigger.

Several defaults can coexist only because every account is held to a single domain (`assertSingleDomain` in `item_service.ts`, and the write-once `POST /api/v1/user/domains`; see `api-items-single-domain-lock.md`). Otherwise one per-account tag would cover two domains and let one domain's default decrypt the other's participant. `participant_decrypt` additionally filters on the acting org's declared domains, so a leak would need both invariants to fail.

## Tagging is per account

Ownership is a property of the account, decided once when its domain is decided, so tagging runs where the domain is established (`tagUserForDomain` from signup extras and `POST /api/v1/user/domains`; `create_item` calls `tagUserWithDefaultAggregator` directly with the request's concrete network) rather than on every item write. The `owner_required` go-live gate only reads the result (`resolveOwnerGateContext`).
