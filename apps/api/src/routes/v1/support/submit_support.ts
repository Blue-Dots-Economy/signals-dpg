import z from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema/auth';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { instance, supportConfig } from '@/config';
import { getDefaultEmailSender } from '@/notifications/email/dispatch_email';
import {
  buildSupportDetailsTable,
  generateSupportReference,
  TYPE_LABELS,
} from '@/support/build_support_email';

const SubmitSupportBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().email().max(320).optional(),
  phone: z.string().min(3).max(20).optional(),
  type: z.enum(['complaint', 'support_request']),
  details: z.string().trim().min(1).max(5000),
  consent: z.literal(true),
});

type Body = z.infer<typeof SubmitSupportBody>;

export const submit_support: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['support'],
      body: SubmitSupportBody,
    },
    handler: submit_support_handler,
  });
};

export const submit_support_handler = async (
  request: FastifyRequest<{ Body: Body }>,
  reply: FastifyReply
) => {
  const userId = request.user?.id;
  if (!userId) {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });
  }

  const { name, email, phone, type, details } = request.body;

  // At least one contact channel is required so the team can respond. The
  // schema-level failures (missing consent, empty details) are 400'd by the
  // type provider; this rule returns the route's own {error,message} shape.
  const submittedEmail = email?.trim() || undefined;
  const submittedPhone = phone?.trim() || undefined;
  if (!submittedEmail && !submittedPhone) {
    return reply.code(400).send({
      error: 'CONTACT_REQUIRED',
      message: 'Provide at least one contact: an email or a phone number.',
    });
  }

  const sender = getDefaultEmailSender();
  if (!supportConfig.recipients || !supportConfig.fromEmail || !sender) {
    return reply.code(503).send({
      error: 'SUPPORT_NOT_CONFIGURED',
      message: 'Support is not configured on this instance.',
    });
  }

  // The submitted contact details are the source of truth for the email; the
  // user row is only looked up to confirm the account still exists.
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row) {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'User not found' });
  }

  const reference = generateSupportReference(new Date());
  const teamName = supportConfig.teamName ?? 'Support';

  try {
    await sender.dispatchEmail({
      caseId: 'support.request',
      to: supportConfig.recipients,
      fromName: `${instance.INSTANCE_NAME ?? 'DPG'} Support`,
      replyTo: submittedEmail ?? supportConfig.fromEmail,
      ...(supportConfig.cc ? { cc: supportConfig.cc } : {}),
      // Per-submission dedupe key. Without it the notification-service falls
      // back to `${channel}:${to}:${template_id}` (constant per instance), so
      // two submissions to the same inbox within its dedupe TTL collapse and
      // the second is silently dropped. The unique reference closes that.
      dedupeId: reference,
      variables: {
        reference,
        type: TYPE_LABELS[type],
        name,
        fromSite: supportConfig.linkBaseUrl ? ` from ${supportConfig.linkBaseUrl}` : '',
        details,
        teamName,
        detailsTable: buildSupportDetailsTable({
          reference,
          name,
          email: submittedEmail ?? null,
          phone: submittedPhone ?? null,
          submittedAt: new Date().toISOString(),
        }),
      },
      log: (message, meta) => request.log.warn(meta ?? {}, message),
    });
  } catch (err) {
    request.log.error({ err }, 'support email send failed');
    return reply.code(502).send({
      error: 'SUPPORT_SEND_FAILED',
      message: 'Failed to send your message. Please try again later.',
    });
  }

  return reply.code(201).send({ ok: true, reference });
};
