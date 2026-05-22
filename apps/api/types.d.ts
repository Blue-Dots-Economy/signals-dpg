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
     * The aggregator / voice org this request is acting on behalf of.
     * Populated by the acting_org preHandler (mounted on /api/v1/admin/*
     * and the aggregator-facing read paths). Absent on routes that don't
     * require the preHandler — handlers MUST treat this as optional.
     *
     * - `org_id`           — the aggregator org's id in the Signals
     *                        organization table (mirrored from
     *                        aggregator-dpg via POST /api/v1/admin/aggregator/upsert).
     * - `org_type`         — 'aggregator' | 'voice' | 'network_service'.
     *                        The preHandler accepts all three; route handlers
     *                        can narrow further (e.g. onboarding rejects
     *                        network_service callers; aggregator dashboards
     *                        require 'aggregator').
     * - `service_user_id`  — the user that owns the apikey that authenticated
     *                        the request (i.e. the integrating DPG's service
     *                        account in Signals).
     */
    acting_org?: {
      org_id: string;
      org_type: 'aggregator' | 'voice' | 'network_service';
      service_user_id: string;
    };
  }
}
