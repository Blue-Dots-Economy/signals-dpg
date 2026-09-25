import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      id: string;
      email: string;
      name: string;
      role?: string | null | undefined;
      [key: string]: any;
    };
    permissions?: Record<string, string[]>;
    /**
     * The aggregator / network-service org this request is acting on behalf of.
     * Populated by the acting_org preHandler (mounted on /api/v1/admin/*
     * and the aggregator-facing read paths). Absent on routes that don't
     * require the preHandler — handlers MUST treat this as optional.
     *
     * - `org_id`           — the aggregator org's id in the Signals
     *                        organization table (mirrored from
     *                        aggregator-dpg via POST /api/v1/admin/aggregator/upsert).
     * - `org_type`         — 'aggregator' | 'network_service'.
     *                        The preHandler accepts both; route handlers can
     *                        narrow further (e.g. aggregator dashboards require
     *                        'aggregator'). #518 retired a third type, `voice`,
     *                        which reached exactly as far as `network_service`;
     *                        the voice channel is identified by the token's
     *                        `azp`, not by its org type.
     * - `service_user_id`  — the user that owns the apikey that authenticated
     *                        the request (i.e. the integrating DPG's service
     *                        account in Signals).
     */
    acting_org?: {
      org_id: string;
      org_type: 'aggregator' | 'network_service';
      service_user_id: string;
    };
    /**
     * The acting-org grant carried by a verified Keycloak token — the set of
     * org ids this caller may assert via `x-acting-org-id` (§5.1 of the Keycloak
     * migration design). `['*']` means any.
     *
     * INTERNAL plumbing between the auth middleware and `acting_org.ts`; route
     * handlers should keep reading `request.acting_org`, whose shape is
     * unchanged. `undefined` means the token carried no grant at all — which
     * `ACTING_ORG_SOURCE=claim_preferred` treats as "fall back to the header"
     * and `claim_required` refuses.
     */
    acting_org_grant?: string[];
    /**
     * The Keycloak client id (`azp`) a service-account token was issued to —
     * e.g. `aggregator-dpg`, `voice-dpg`. Set only on the client-credentials
     * path; `undefined` for cookie sessions and apikey callers.
     *
     * This is the audit channel #518 left behind when it retired the `voice`
     * org type. Every service org is `network_service` now, so `acting_org`
     * identifies the TIER and this identifies the SERVICE. Use it for audit,
     * support triage and logging — never for authorization, which is the
     * distinction the retired type got wrong.
     */
    service_client_id?: string;
  }
}
