# Acting-org scope model

Code: `apps/api/src/middleware/acting_org.ts` (layer 1),
`apps/api/src/routes/v1/action/_resolve_acting_actor.ts` and the admin read
paths such as `apps/api/src/routes/v1/admin/participant_decrypt.ts` (layer 2).

An on-behalf-of request carries three things: a credential (who the caller is),
`x-acting-org-id` (the org it acts as), and the target user. Authorisation of
that combination is split across two layers.

1. **Caller -> acting org** (`acting_org_preHandler`). Validates that the org
   exists, that its type may be asserted as an acting org (`aggregator` or
   `network_service`), and that the caller has at least one `member` row. With
   `ACTING_ORG_SOURCE=header` (the default) it does not bind the org to the
   caller: any member principal may name any org of an allowed type. With
   `claim_preferred` / `claim_required`, the asserted org must also be inside
   the token's `signals_acting_orgs` grant (`["*"]` means any org).
2. **Acting org -> target user**, enforced per route. An `aggregator` acting org
   reaches only users it onboarded (`user.onboardedByOrgId`).
   `network_service` is network-wide by design; see the rationale in
   `_resolve_acting_actor.ts`.

So the reach of a request is set by the type of the org asserted, and that
reach is checked; with header mode, the choice of which org to assert is not.

## Who can reach layer 1

`member` rows are written by `apps/api/scripts/seed_service_users.ts` (service
principals, all with org `type: 'network_service'`), by the deploy-time
`provision_service_users.sql`, and at first Keycloak login by
`services/auth/provisioning.ts` when a human token's grant names exactly one
org. A participant without an org grant has no `member` row and is refused
before it can assert any acting org. The member check separates privilege tiers,
not tenants.

The voice channel is identified by the token's `azp`, not by an org type.

## Restricting a principal to part of the network

Layer 2 cannot express "this service may reach only some orgs". If such a
principal is provisioned (a regional aggregator, a partner integration), layer 1
must carry the restriction: set `ACTING_ORG_SOURCE=claim_preferred` (or
`claim_required`) and populate the `signals_acting_orgs` claim for that
principal, in the same change that adds it.
