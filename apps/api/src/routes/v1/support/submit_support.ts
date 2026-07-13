import z from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema/auth';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig, instance, supportConfig } from '@/config';
import { getNotificationClient } from '@/utils/notificationClient';
import { buildSupportEmail } from '@/support/build_support_email';

const SubmitSupportBody = z.object({
  subject: z.string().max(200).optional(),
  message: z.string().min(1).max(5000),
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

  const nc = getNotificationClient();
  if (!supportConfig.recipient || !supportConfig.fromEmail || !nc) {
    return reply.code(503).send({
      error: 'SUPPORT_NOT_CONFIGURED',
      message: 'Support is not configured on this instance.',
    });
  }

  const { subject, message } = request.body;

  const [row] = await db
    .select({ name: user.name, email: user.email, phone: user.phoneNumber })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row) {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'User not found' });
  }

  const network =
    [...new Set(apiConfig.served_domains.map((binding) => binding.network))].join(', ') || '—';

  const { subject: emailSubject, html } = buildSupportEmail({
    subject,
    message,
    submitter: {
      name: row.name,
      email: row.email,
      phone: row.phone,
      userId,
      network,
    },
    submittedAt: new Date().toISOString(),
  });

  try {
    await nc.notify({
      channel: 'email',
      template_id: 'basic_email',
      to: supportConfig.recipient,
      priority: 'other',
      variables: {
        fromName: `${instance.INSTANCE_NAME ?? 'DPG'} Support`,
        fromEmail: supportConfig.fromEmail,
        replyTo: row.email ?? supportConfig.fromEmail,
        subject: emailSubject,
        html,
      },
    });
  } catch (err) {
    request.log.error({ err }, 'support email send failed');
    return reply.code(502).send({
      error: 'SUPPORT_SEND_FAILED',
      message: 'Failed to send your message. Please try again later.',
    });
  }

  return reply.code(201).send({ ok: true });
};
