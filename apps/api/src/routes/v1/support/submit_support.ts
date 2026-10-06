import z from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema/auth';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { NotifyTransportError, SUPPORT_REQUEST, type NotifyEvent } from '@dpg/notification';
import { supportConfig } from '@/config';
import { generateSupportReference, TYPE_LABELS } from '@/support/build_support_email';
import {
  formatBytes,
  supportBodyLimitBytes,
  validateSupportAttachments,
} from '@/support/attachments';
import { getNotificationClient } from '@/utils/notificationClient';
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

/** The notification service accepts at most this many cc addresses. */
const SUPPORT_MAX_CC = 10;

const splitEmailList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * Splits the configured support inbox(es) into the event's single `to` and its
 * `cc` (F2-6): `/v1/notify` has one `to.email`, so the first SUPPORT_EMAIL
 * address is `to`, and the remaining ones plus SUPPORT_CC_EMAIL go to `cc`,
 * de-duplicated (case-insensitively, and against `to`) and capped at 10. The
 * same people receive the email; the extra inboxes now show on the Cc line.
 */
export function splitSupportRecipients(
  recipients: string | undefined,
  cc: string | undefined,
): { to: string; cc: string[]; dropped: number } | null {
  const [to, ...rest] = splitEmailList(recipients);
  if (!to) return null;
  const seen = new Set([to.toLowerCase()]);
  const unique: string[] = [];
  for (const address of [...rest, ...splitEmailList(cc)]) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(address);
  }
  return {
    to,
    cc: unique.slice(0, SUPPORT_MAX_CC),
    dropped: Math.max(0, unique.length - SUPPORT_MAX_CC),
  };
}

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

  const nc = getNotificationClient();
  const recipients = splitSupportRecipients(supportConfig.recipients, supportConfig.cc);
  if (!recipients || !nc) {
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

  if (recipients.dropped > 0) {
    request.log.warn(
      { kept: recipients.cc.length, dropped: recipients.dropped },
      'support: more cc addresses than the notification service accepts; extra ones dropped',
    );
  }

  const event: NotifyEvent = {
    event_type: SUPPORT_REQUEST,
    domain: null,
    to: { email: recipients.to },
    ...(recipients.cc.length ? { cc: recipients.cc } : {}),
    // With no submitted email, replies go to the deployment's From address.
    ...(submittedEmail ? { reply_to: submittedEmail } : {}),
    // Attachments ride beside the variables, never in them.
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
      // The contact-details rows are fixed template rows, so each always gets
      // a value (R5).
      phone: submittedPhone ?? '—',
      email: submittedEmail ?? '—',
      submittedAt: new Date().toISOString(),
      attachmentsSummary: attachments.length
        ? attachments.map(({ filename, bytes }) => `${filename} (${formatBytes(bytes)})`).join(', ')
        : 'none',
    },
    priority: 'normal',
    // The reference is unique per submission, so a second request is a second
    // send (R12), while a retry of this one cannot deliver it twice.
    idempotency_key: reference,
  };

  // Critical: a lost support request must surface to the user as a 502.
  try {
    const result = await nc.send(event);
    if (!result.ok) {
      request.log.error(
        { event_type: SUPPORT_REQUEST, reference, status: result.status, error: result.error, kind: result.kind },
        'support: ns_rejected',
      );
      return sendFailed(reply);
    }
  } catch (err) {
    if (err instanceof NotifyTransportError) {
      request.log.error({ event_type: SUPPORT_REQUEST, reference, error: err.message }, 'support: ns_unreachable');
    } else {
      request.log.error({ err, reference }, 'support: send failed');
    }
    return sendFailed(reply);
  }

  return reply.code(201).send({ ok: true, reference });
};

const sendFailed = (reply: FastifyReply) =>
  reply.code(502).send({
    error: 'SUPPORT_SEND_FAILED',
    message: 'Failed to send your message. Please try again later.',
  });
