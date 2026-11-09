import { buildNotifications } from './build_notifications';
import type { NotificationEvent, NotificationPlan } from './build_notifications';
import type { DispatchEmailArgs } from './email/dispatch_email';
import { smsLink } from './sms/default_sms_sender';
import type { SmsDispatchArgs } from './sms/dispatch_sms';
import {
  FALLBACK_SERVICE_NAME,
  resolveCopyGroup,
  resolveRecipientRole,
} from './action_copy';
import { actionCaseId } from './email/email_cases';

export interface DispatcherDeps {
  /** Sends one rendered email (the central email sender, #529). */
  sendEmail: (args: DispatchEmailArgs) => Promise<{ ok: boolean }>;
  /** Resolves a local owner's email by user id; null when unknown/phone-only. */
  resolveEmail: (userId: string) => Promise<string | null>;
  /**
   * Resolves the counterparty's service name for `{{name}}` in seeker-facing
   * copy (the provider's Service Name); null for provider-facing copy.
   */
  resolveCounterpartyName: (plan: NotificationPlan) => Promise<string | null>;
  brand: {
    brandName: string;
  };
  /**
   * The login URL for a recipient in `domain`. Per-recipient, not per-process:
   * on a split deployment each domain has its own portal host (#569).
   */
  resolveCtaUrl: (domain: string) => string | undefined;
  log: (message: string, meta?: Record<string, unknown>) => void;
  /** Visibility hook for skipped (dark) recipients. */
  onSkip: (reason: string) => void;
  /** Sends the plan's SMS case; skips on its own where the case has no template. */
  sendSms?: (args: SmsDispatchArgs) => Promise<unknown>;
  /** The owner's verified phone; null when there is none. */
  resolvePhone?: (userId: string) => Promise<string | null>;
}

export interface DirectDispatcher {
  dispatch: (event: NotificationEvent) => Promise<void>;
}

/**
 * Resolves recipients and hands each plan to the central email sender.
 * Fire-and-forget by contract: a failure for any plan is logged and never
 * propagates, so it can never fail or slow the action route. The Phase-2
 * transport (Kafka/registry) swaps in behind this same interface.
 */
export function createDirectDispatcher(deps: DispatcherDeps): DirectDispatcher {
  async function dispatchPlan(plan: NotificationPlan): Promise<void> {
    if (!plan.recipientUserId) {
      deps.onSkip('no_user_id');
      deps.log('notification skipped: owner has no user id', {
        shape: plan.shape,
        actionId: plan.actionId,
      });
      return;
    }

    const caseId = actionCaseId(
      resolveCopyGroup(plan.actionType),
      resolveRecipientRole(plan.recipientDomain),
      plan.shape,
    );
    // Sent before the email checks, so a phone-only owner still hears about it;
    // an SMS failure must not cost the email.
    if (deps.sendSms && deps.resolvePhone) {
      try {
        const phone = await deps.resolvePhone(plan.recipientUserId);
        if (phone) {
          const url = smsLink(deps.resolveCtaUrl(plan.recipientDomain));
          const name = (await deps.resolveCounterpartyName(plan))?.trim() || FALLBACK_SERVICE_NAME;
          await deps.sendSms({
            caseId,
            to: phone,
            network: plan.counterpartyNetwork,
            variables: url ? { name, url } : { name },
          });
        }
      } catch (err) {
        deps.log('notification sms failed', {
          error: err instanceof Error ? err.message : String(err),
          shape: plan.shape,
          actionId: plan.actionId,
        });
      }
    }

    const email = await deps.resolveEmail(plan.recipientUserId);
    if (!email) {
      deps.onSkip('no_email');
      deps.log('notification skipped: owner has no email', {
        shape: plan.shape,
        actionId: plan.actionId,
      });
      return;
    }

    // `dispatch_email` renders `args.ctaUrl ?? ''` into the shell, so an
    // unresolved URL ships an `<a href="">` whose button does nothing. That is
    // now reachable: the gate below accepts a map-only config, so a domain
    // missing from UI_HOST_BINDINGS with no FRONTEND_BASE_URL set has no
    // answer. Send nothing rather than a mail whose only CTA is broken — the
    // boot-time unknown-domain warning is the operator-facing signal.
    //
    // The RECIPIENT's own domain, never the counterparty's — keying off
    // `counterpartyDomain` here would send each party to the other's portal.
    const ctaUrl = deps.resolveCtaUrl(plan.recipientDomain);
    if (!ctaUrl) {
      deps.onSkip('no_cta_url');
      deps.log('notification skipped: no CTA url for recipient domain', {
        shape: plan.shape,
        actionId: plan.actionId,
        domain: plan.recipientDomain,
      });
      return;
    }

    const counterpartyName = await deps.resolveCounterpartyName(plan);

    await deps.sendEmail({
      caseId,
      to: email,
      fromName: deps.brand.brandName,
      network: plan.counterpartyNetwork,
      ctaUrl,
      dedupeId: `${plan.actionId}:${plan.updateCount}:${plan.shape}`,
      variables: { name: counterpartyName?.trim() || FALLBACK_SERVICE_NAME },
      log: deps.log,
    });
  }

  return {
    async dispatch(event: NotificationEvent): Promise<void> {
      const plans = buildNotifications(event);
      for (const plan of plans) {
        try {
          await dispatchPlan(plan);
        } catch (err) {
          deps.log('notification dispatch failed', {
            err,
            shape: plan.shape,
            actionId: plan.actionId,
          });
        }
      }
    },
  };
}
