import { apiConfig, instance, notification } from '@/config';
import { getNotificationClient } from '@/utils/notificationClient';

import { resolveBrandColor } from '../brand';
import { getEmailCase } from './email_cases';
import { getEmailMessages } from './messages';
import type { EmailMessagesIndex } from './messages';
import { renderCtaShell, renderOtpBox, renderPlainShell, renderSiteLink } from './shells';
import { substituteHtml, substitutePlain } from './substitute';

/**
 * The single email send path: copy lookup, token substitution (the escaping
 * boundary), HTML shell, then notification-service. Critical cases rethrow so
 * the caller can surface the failure; best-effort cases log and never throw,
 * so an email failure never blocks the triggering action.
 */
/** A file to attach. Base64 because it travels to notification-service as JSON. */
export interface EmailAttachment {
  filename: string;
  contentType: string;
  /** Base64, no `data:` prefix. */
  data: string;
}

export interface EmailNotifyRequest {
  channel: 'email';
  template_id: 'basic_email';
  to: string;
  priority: 'realtime' | 'other';
  dedupe_id?: string;
  variables: {
    fromName: string;
    fromEmail: string;
    replyTo: string;
    subject: string;
    html: string;
    cc?: string;
    attachments?: EmailAttachment[];
  };
}

export interface DispatchEmailArgs {
  caseId: string;
  to: string;
  /** From-name shown to the recipient (brand, "<X> Support", "Welcome to <X>", …). */
  fromName: string;
  variables?: Record<string, string>;
  dedupeId?: string;
  replyTo?: string;
  cc?: string;
  /** Kept out of `variables` so attachments never pass through token substitution. */
  attachments?: EmailAttachment[];
  /** cta-shell cases only: */
  ctaUrl?: string;
  network?: string;
  /** Brand id for the brand copy layer. No caller sets it yet. */
  brand?: string;
  /** Per-call log override (route handlers pass request.log-backed fns). */
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface EmailSender {
  dispatchEmail(args: DispatchEmailArgs): Promise<{ ok: boolean }>;
}

export interface EmailSenderDeps {
  notify: (req: EmailNotifyRequest) => Promise<unknown>;
  getMessages: () => Promise<EmailMessagesIndex>;
  fromEmail: string;
  defaultReplyTo: string;
  /**
   * Copy network for sends that pass no `args.network` (guardian OTP, welcome,
   * support): the instance's single served network, or `null` on a
   * multi-network instance (base copy). `args.network` wins when present.
   */
  defaultNetwork: string | null;
  /**
   * "Team <name>" sign-off in the cta shell: the operating org (INSTANCE_NAME),
   * not the network display name. Falls back to `args.fromName`.
   */
  teamName?: string;
  log: (message: string, meta?: Record<string, unknown>) => void;
}

/** Collapse CR/LF/tabs so a substituted subject can't inject email headers. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function createEmailSender(deps: EmailSenderDeps): EmailSender {
  async function send(args: DispatchEmailArgs): Promise<void> {
    const def = getEmailCase(args.caseId);
    const messages = (await deps.getMessages()).forContext(
      args.network ?? deps.defaultNetwork,
      args.brand,
    );

    const vars: Record<string, string> = { ...args.variables };
    // The styled OTP box is code-built from the plain `otp` when the caller omits it.
    if (def.tokens.otpBox === 'html' && vars.otp !== undefined && vars.otpBox === undefined) {
      vars.otpBox = renderOtpBox(vars.otp);
    }
    // The platform link is always resolved (plain text when there is no URL) so
    // copy never renders a dead anchor or a literal {{token}}.
    if (def.tokens.siteLink === 'html' && vars.siteLink === undefined) {
      vars.siteLink = renderSiteLink(vars.siteUrl);
    }

    const subject = oneLine(
      substitutePlain(messages.get(def.keys.subject), vars, def.tokens),
    );
    const bodyHtml = substituteHtml(messages.get(def.keys.body), vars, def.tokens);

    const html =
      def.shell === 'cta'
        ? renderCtaShell({
            introHtml: bodyHtml,
            ctaUrl: args.ctaUrl ?? '',
            ctaLabel: substitutePlain(
              messages.get(def.keys.cta as string),
              vars,
              def.tokens,
            ),
            ctaColor: resolveBrandColor(args.network),
            brandName: deps.teamName ?? args.fromName,
          })
        : renderPlainShell(bodyHtml);

    await deps.notify({
      channel: 'email',
      template_id: 'basic_email',
      to: args.to,
      priority: def.priority,
      ...(args.dedupeId ? { dedupe_id: args.dedupeId } : {}),
      variables: {
        fromName: args.fromName,
        fromEmail: deps.fromEmail,
        replyTo: args.replyTo ?? deps.defaultReplyTo,
        subject,
        html,
        ...(args.cc ? { cc: args.cc } : {}),
        ...(args.attachments?.length ? { attachments: args.attachments } : {}),
      },
    });
  }

  return {
    async dispatchEmail(args: DispatchEmailArgs): Promise<{ ok: boolean }> {
      const log = args.log ?? deps.log;
      try {
        await send(args);
        return { ok: true };
      } catch (err) {
        if (getEmailCase(args.caseId).criticality === 'critical') throw err;
        log('email dispatch failed', { err, caseId: args.caseId });
        return { ok: false };
      }
    },
  };
}

/**
 * The single distinct network across `apiConfig.served_domains`, or `null` when
 * the instance serves zero or several (no right default, so base copy is used).
 */
export function getInstanceDefaultNetwork(): string | null {
  const networks = [
    ...new Set(apiConfig.served_domains.map((binding) => binding.network)),
  ];
  return networks.length === 1 ? networks[0] : null;
}

/** Sender address when NOTIFICATION_FROM_EMAIL is unset. */
export const DEFAULT_FROM_EMAIL = 'hello@bluedotseconomy.org';

let defaultSender: EmailSender | null | undefined;

export function getDefaultEmailSender(): EmailSender | null {
  if (defaultSender !== undefined) return defaultSender;
  const nc = getNotificationClient();
  if (!nc) {
    defaultSender = null;
    return defaultSender;
  }
  const fromEmail = notification.NOTIFICATION_FROM_EMAIL ?? DEFAULT_FROM_EMAIL;
  defaultSender = createEmailSender({
    notify: (req) => nc.notify(req),
    getMessages: getEmailMessages,
    fromEmail,
    defaultReplyTo: notification.NOTIFICATION_REPLY_TO ?? fromEmail,
    defaultNetwork: getInstanceDefaultNetwork(),
    teamName: instance.INSTANCE_NAME || 'DPG',
    log: (message, meta) => console.warn(message, meta ?? {}),
  });
  return defaultSender;
}

export function resetDefaultEmailSenderForTests(): void {
  defaultSender = undefined;
}
