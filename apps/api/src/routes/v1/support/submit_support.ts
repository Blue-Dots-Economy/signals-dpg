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
import {
  supportBodyLimitBytes,
  validateSupportAttachments,
} from '@/support/attachments';
import { incrWithinWindow } from '@/utils/rate_window';

const SubmitSupportBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().email().max(320).optional(),
  phone: z.string().min(3).max(20).optional(),
  type: z.enum(['complaint', 'support_request']),
  details: z.string().trim().min(1).max(5000),
  consent: z.literal(true),
  // Count/size/type limits are enforced in the handler by
  // validateSupportAttachments so each rejection gets its own error code and a
  // message naming the offending file — a zod bound could only produce a
  // generic 400 (#551).
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        contentType: z.string().min(1).max(127),
        /** Base64, no `data:` prefix. */
        data: z.string().min(1),
      }),
    )
    .optional(),
});

type Body = z.infer<typeof SubmitSupportBody>;

/** Submissions allowed per user per window — the endpoint accepts multi-MB uploads. */
const SUPPORT_MAX_PER_WINDOW = 5;
const SUPPORT_WINDOW_SEC = 3600;

export const submit_support: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    // Fastify's 1 MB default applies per route; every other route keeps it.
    // Derived from the attachment budget so raising
    // SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES cannot turn into a silent 413.
    bodyLimit: supportBodyLimitBytes(supportConfig.attachmentMaxTotalBytes),
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

  const sender = getDefaultEmailSender();
  if (!supportConfig.recipients || !supportConfig.fromEmail || !sender) {
    return reply.code(503).send({
      error: 'SUPPORT_NOT_CONFIGURED',
      message: 'Support is not configured on this instance.',
    });
  }

  // Per-user cap: the endpoint accepts multi-MB uploads that sit in the
  // notification-service queue until delivered.
  //
  // Counted BEFORE the body is validated, deliberately. Fastify has already
  // buffered and parsed the payload by the time any of this runs, so a rejected
  // submission has cost the same as an accepted one — if only accepted ones
  // counted, a caller could post oversized rubbish (a fourth file, a disallowed
  // content type) without limit and never spend a slot. The client validates the
  // same rules before submitting, so a legitimate user does not reach here with
  // an invalid body and rarely spends a slot on a mistake.
  //
  // Still after the 503: an instance with no support address should not burn
  // anyone's quota. Fails OPEN on a Redis error — a rate-limit backend outage
  // must not silence someone's complaint.
  try {
    const submissions = await incrWithinWindow(`support:rl:${userId}`, SUPPORT_WINDOW_SEC);
    if (submissions > SUPPORT_MAX_PER_WINDOW) {
      return reply.code(429).send({
        error: 'SUPPORT_RATE_LIMITED',
        message: 'Too many support submissions; please try again later.',
      });
    }
  } catch (err) {
    request.log.warn({ err }, 'support rate-limit check unavailable; allowing submission');
  }

  const attachmentCheck = validateSupportAttachments(request.body.attachments, {
    maxFiles: supportConfig.attachmentMaxFiles,
    maxTotalBytes: supportConfig.attachmentMaxTotalBytes,
  });
  if (!attachmentCheck.ok) {
    return reply.code(400).send({ error: attachmentCheck.error, message: attachmentCheck.message });
  }
  const attachments = attachmentCheck.attachments;

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
      ...(attachments.length
        ? {
            attachments: attachments.map(({ filename, contentType, data }) => ({
              filename,
              contentType,
              data,
            })),
          }
        : {}),
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
          attachments: attachments.map(({ filename, bytes }) => ({ filename, bytes })),
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
