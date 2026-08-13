import { apiConfig, instance, notification } from '@/config';
import { getNotificationClient } from '@/utils/notificationClient';

import { resolveBrandColor } from '../brand';
import { getEmailCase } from './email_cases';
import { getEmailMessages } from './messages';
import type { EmailMessagesIndex } from './messages';
import { renderCtaShell, renderOtpBox, renderPlainShell } from './shells';
import { substituteHtml, substitutePlain } from './substitute';

/**
 * The single email send path (#529): copy lookup → token substitution
 * (escaping boundary) → HTML shell → notification service. Criticality comes
 * from the case registry: critical sends rethrow so the caller can surface
 * delivery failure (OTP 502s, support 502); best-effort sends never throw —
 * an email failure must never block the action that triggered it.
 */
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
  /** cta-shell cases only: */
  ctaUrl?: string;
  network?: string;
  /**
   * Brand id for copy resolution (`forContext`'s brand layer). No caller sets
   * this yet — brand isn't resolvable at send time anywhere in the system
   * today; this is the hook for when it is (a per-plan brand, analogous to
   * `network`).
   */
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
   * Network used for context-free sends (guardian/login OTP, welcome,
   * support — callers that pass no `args.network`): the instance's single
   * served network, or `null` on a multi-network instance (those sends keep
   * base copy rather than guessing). Per-plan `args.network` (action/retire)
   * always wins over this when present — see `send()` below.
   */
  defaultNetwork: string | null;
  /**
   * "Team <name>" sign-off in the cta shell (the operating org, e.g.
   * INSTANCE_NAME "EkStep"/"ALIMCO" — per the email content sheet), NOT the
   * network display name. Falls back to `args.fromName` when unset so
   * sender-less test wiring keeps a sensible sign-off.
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
    // The styled OTP box is code-built (html token) even when the caller —
    // e.g. packages/auth — only knows the plain code.
    if (def.tokens.otpBox === 'html' && vars.otp !== undefined && vars.otpBox === undefined) {
      vars.otpBox = renderOtpBox(vars.otp);
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
 * Instance default network for context-free email sends (guardian/login OTP,
 * welcome, support — the callers that never pass `args.network`): the single
 * distinct network across `apiConfig.served_domains` bindings, mirroring how
 * `consent_configs.ts`/`email/messages.ts` derive the served-networks set.
 * `null` when the instance serves zero or more-than-one network — a
 * multi-network instance has no single right default, so those sends keep
 * base copy rather than guessing. Reused by `notify_actions.ts`'s
 * `resolveNotifierConfig()`.
 */
export function getInstanceDefaultNetwork(): string | null {
  const networks = [
    ...new Set(apiConfig.served_domains.map((binding) => binding.network)),
  ];
  return networks.length === 1 ? networks[0] : null;
}

/**
 * Preserves the previously-hardcoded auth-email sender when
 * NOTIFICATION_FROM_EMAIL is unset, so no config permutation loses email.
 */
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
