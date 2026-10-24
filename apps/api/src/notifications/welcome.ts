/**
 * Welcome notifications for a genuinely-new user, sent from `createMirror` in
 * `services/auth/provisioning.ts` when a Keycloak login first creates the local
 * user row.
 *
 * Never throws: a welcome message must not fail a signup or login.
 */

import { instance, notification, uiHostBindings } from '@/config';
import { getNotificationClient } from '@/utils/notificationClient';

import { createCtaUrlResolver } from './brand';
import { getDefaultEmailSender } from './email/dispatch_email';
import { resolveRecipientRole } from './action_copy';

/** Pre-approved Twilio content template; `contentVariables['1']` is the recipient's name. */
const WELCOME_WHATSAPP_CONTENT_SID = 'HX3f2a5d7e4a18e5664124592a12a154eb';

/** Just enough of the user to address them. */
export interface WelcomeRecipient {
  name: string;
  email: string | null;
  phoneNumber: string | null;
}

/** Minimal logger shape; `FastifyBaseLogger` satisfies it. */
export interface WelcomeLog {
  error: (details: Record<string, unknown>, message: string) => void;
}

/**
 * Sends the welcome email and/or WhatsApp message. Each channel's failure is
 * logged and swallowed, so one dead channel cannot suppress the other. No-op
 * when no notification client is configured.
 */
export async function sendWelcomeNotifications(
  recipient: WelcomeRecipient,
  log: WelcomeLog,
  /**
   * The signup domain, when known; picks the portal link on a split deployment.
   * Without it the link falls back to FRONTEND_BASE_URL, then to no link.
   */
  domain?: string | null
): Promise<void> {
  const nc = getNotificationClient();
  if (!nc) return;

  const appName = instance.INSTANCE_NAME ?? 'DPG';

  if (recipient.email) {
    // `welcome.*` is best-effort, so dispatchEmail already swallows send
    // failures; the catch covers URL resolution and setup errors.
    try {
      const siteUrl = domain
        ? createCtaUrlResolver({
            byDomain: uiHostBindings.byDomain,
            fallbackBaseUrl: notification.FRONTEND_BASE_URL,
          })(domain)
        : notification.FRONTEND_BASE_URL;

      // Domain-less accounts get the generic `welcome` copy.
      const caseId = domain ? `welcome.${resolveRecipientRole(domain)}` : 'welcome';

      const sender = getDefaultEmailSender();
      await sender?.dispatchEmail({
        caseId,
        to: recipient.email,
        fromName: appName,
        variables: {
          userName: recipient.name || 'user',
          appName,
          // Omitted when unresolved so renderSiteLink falls back to plain text
          // instead of an empty link.
          ...(siteUrl ? { siteUrl } : {}),
          teamName: appName,
        },
      });
    } catch (err) {
      log.error({ err }, 'welcome: could not send the welcome email');
    }
  }

  if (recipient.phoneNumber) {
    try {
      await nc.notify({
        channel: 'whatsapp',
        template_id: 'other',
        to: recipient.phoneNumber,
        priority: 'realtime',
        variables: {
          contentSid: WELCOME_WHATSAPP_CONTENT_SID,
          contentVariables: {
            '1': recipient.name,
          },
        },
      });
    } catch (err) {
      log.error({ err }, 'welcome: could not send the welcome WhatsApp message');
    }
  }
}
