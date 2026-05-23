import type { FastifyRequest, FastifyReply } from 'fastify';
import { acting_org_preHandler } from './acting_org.js';

const get_header_value = (raw: string | string[] | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Optional variant of `acting_org_preHandler`.
 *
 * - Header absent (or blank-after-trim) → leave `request.acting_org`
 *   undefined and resolve. The downstream route handler decides whether
 *   that's allowed.
 * - Header present → delegate to the strict preHandler, which either
 *   attaches `request.acting_org` or terminates the request with an
 *   error reply.
 *
 * Mount this on routes that need to accept BOTH self-acted calls and
 * acting_org-scoped calls (e.g. `/api/v1/action/*`).
 */
export const acting_org_preHandler_optional = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const acting_org_id = get_header_value(
    request.headers['x-acting-org-id'] as string | string[] | undefined,
  );
  if (!acting_org_id) {
    return;
  }
  await acting_org_preHandler(request, reply);
};
