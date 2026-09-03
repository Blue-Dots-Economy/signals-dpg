import z from 'zod';

/**
 * The error envelope every route in this repo already returns —
 * `reply.code(N).send({ error, message })` with a machine-readable `error`
 * code (see the routing conventions in CLAUDE.md).
 *
 * It exists as a schema so a route can *declare* its failure responses instead
 * of only its 200, which is what puts them in the generated OpenAPI document
 * that integrating DPGs read. Most older routes declare only the success
 * shape; new routes should use this, and existing ones can adopt it without a
 * behaviour change since the runtime payload is unchanged.
 */
export const AdminErrorResponse = z.object({
  error: z
    .string()
    .describe(
      'machine-readable error code. Route-specific; for /admin/aggregator/default one of ' +
        'NOT_NETWORK_SERVICE, ACTOR_UNRESOLVED, UNSERVED_DOMAIN_BINDING, ORG_NOT_FOUND, ' +
        'NOT_AN_AGGREGATOR, DOMAIN_NOT_DECLARED, DEFAULT_ALREADY_SET, DEFAULT_AGGREGATOR_WRITE_FAILED. ' +
        "Deliberately a string, not an enum: Fastify serialises zod body-validation " +
        "failures through this same envelope with error='Bad Request', which an enum " +
        'would reject at serialisation time and turn into a 500.',
    ),
  message: z.string().describe('human-readable explanation; not for programmatic use'),
});

export type AdminErrorResponse = z.infer<typeof AdminErrorResponse>;
