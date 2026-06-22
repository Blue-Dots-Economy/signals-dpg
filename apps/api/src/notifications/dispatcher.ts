import { buildNotifications } from './build_notifications';
import type { NotificationEvent, NotificationPlan } from './build_notifications';
import { renderActionEmail } from './render_action_email';

export interface NotifyRequest {
  channel: 'email';
  template_id: 'basic_email';
  to: string;
  priority: 'other';
  dedupe_id: string;
  variables: {
    fromName: string;
    fromEmail: string;
    replyTo: string;
    subject: string;
    html: string;
  };
}

export interface DispatcherDeps {
  /** Sends the notification (the existing notification-service client). */
  notify: (req: NotifyRequest) => Promise<unknown>;
  /** Resolves a local owner's email by user id; null when unknown/phone-only. */
  resolveEmail: (userId: string) => Promise<string | null>;
  /**
   * Resolves the counterparty's service name for `{name}` in seeker-facing
   * copy (the provider's Service Name); null for provider-facing copy.
   */
  resolveCounterpartyName: (plan: NotificationPlan) => Promise<string | null>;
  brand: {
    brandName: string;
    fromEmail: string;
    replyTo: string;
    ctaUrl: string;
  };
  log: (message: string, meta?: Record<string, unknown>) => void;
  /** Visibility hook for skipped (dark) recipients. */
  onSkip: (reason: string) => void;
}

export interface DirectDispatcher {
  dispatch: (event: NotificationEvent) => Promise<void>;
}

/**
 * Resolves recipients, renders, and sends one email per notification plan.
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

    const email = await deps.resolveEmail(plan.recipientUserId);
    if (!email) {
      deps.onSkip('no_email');
      deps.log('notification skipped: owner has no email', {
        shape: plan.shape,
        actionId: plan.actionId,
      });
      return;
    }

    const counterpartyName = await deps.resolveCounterpartyName(plan);
    const { subject, html } = renderActionEmail({
      actionType: plan.actionType,
      shape: plan.shape,
      recipientRole: plan.recipientDomain,
      network: plan.counterpartyNetwork,
      counterpartyName: counterpartyName ?? undefined,
      brandName: deps.brand.brandName,
      ctaUrl: deps.brand.ctaUrl,
    });

    await deps.notify({
      channel: 'email',
      template_id: 'basic_email',
      to: email,
      priority: 'other',
      dedupe_id: `${plan.actionId}:${plan.updateCount}:${plan.shape}`,
      variables: {
        fromName: deps.brand.brandName,
        fromEmail: deps.brand.fromEmail,
        replyTo: deps.brand.replyTo,
        subject,
        html,
      },
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
