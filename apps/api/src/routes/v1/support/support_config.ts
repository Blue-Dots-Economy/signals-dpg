import z from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { supportConfig } from '@/config';
import { getDefaultEmailSender } from '@/notifications/email/dispatch_email';
import {
  SUPPORT_ALLOWED_CONTENT_TYPES,
  SUPPORT_ALLOWED_EXTENSIONS,
} from '@/support/attachments';

/**
 * `GET /api/v1/support/config` (#551) — what the support form is allowed to
 * submit on this instance.
 *
 * The limits live here rather than in a `VITE_` variable so there is one source
 * of truth: a UI-side copy would drift from the API and show up as the server
 * rejecting a file the form had accepted. `enabled` also lets the UI hide the
 * entry point instead of submitting blind and surfacing a 503.
 *
 * The `/support` group has no group-level auth hook, so this route sets its own
 * `preHandler` — see `apps/api/CLAUDE.md`, "Route auth wiring".
 */
const SupportConfigResponse = z.object({
  enabled: z.boolean(),
  maxTotalBytes: z.number().int().positive(),
  maxFiles: z.number().int().positive(),
  allowedTypes: z.array(z.string()),
  /** Picker hint only — validation is MIME-based. See attachments.ts. */
  allowedExtensions: z.array(z.string()),
});

export const support_config: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/config',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['support'],
      response: { 200: SupportConfigResponse },
    },
    handler: support_config_handler,
  });
};

export const support_config_handler = async (request: FastifyRequest, reply: FastifyReply) => {
  if (!request.user?.id) {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });
  }

  // Mirrors the submit route's 503 condition exactly, so `enabled: false` and a
  // SUPPORT_NOT_CONFIGURED reply can never disagree.
  const enabled = Boolean(
    supportConfig.recipients && supportConfig.fromEmail && getDefaultEmailSender(),
  );

  return reply.code(200).send({
    enabled,
    maxTotalBytes: supportConfig.attachmentMaxTotalBytes,
    maxFiles: supportConfig.attachmentMaxFiles,
    allowedTypes: [...SUPPORT_ALLOWED_CONTENT_TYPES],
    allowedExtensions: [...SUPPORT_ALLOWED_EXTENSIONS],
  });
};
