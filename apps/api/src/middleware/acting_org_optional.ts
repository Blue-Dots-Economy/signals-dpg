import type { FastifyRequest, FastifyReply } from 'fastify';
import { acting_org_preHandler } from './acting_org.js';

const get_header_value = (raw: string | string[] | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Optional variant of `acting_org_preHandler`, for routes that accept both
 * self-acted and acting-org calls (e.g. `/api/v1/action/*`). With no header
 * (or a blank one), `request.acting_org` stays undefined and the route decides;
 * otherwise the strict preHandler runs.
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
