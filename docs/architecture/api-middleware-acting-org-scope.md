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
   `claim_preferred` / `claim_required`, the asserted org must also be inside
   the token's `signals_acting_orgs` grant (`["*"]` means any org).
2. **Acting org -> target user**, enforced per route. An `aggregator` acting org
   reaches only users it onboarded (`user.onboardedByOrgId`).
   `network_service` is network-wide.

The voice channel is identified by the token's `azp`, not by an org type.

## Restricting a principal to part of the network

Layer 2 cannot express "this principal may reach only some orgs". Use
`ACTING_ORG_SOURCE=claim_preferred` (or `claim_required`) and populate the
`signals_acting_orgs` claim for every principal that can assert an acting org.
