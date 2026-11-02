/**
 * Priority at which a notification should be processed.
 */
export type NotificationPriority = 'realtime' | 'other';

/**
 * Payload sent to the `/notify` endpoint.
 *
 * `variables` must conform to the JSON Schema returned by `/providers` for
 * the given `channel`.
 */
export interface NotifyRequest<TVariables extends Record<string, unknown>> {
  /**
   * Notification channel/provider (e.g. email, sms, whatsapp). Not an enum:
   * the allowed values come from `/providers`.
   */
  channel: string;

  /**
   * Template identifier.
   * Must be selected from `/providers[].templates`.
   */
  template_id: string;

  /**
   * Recipient identifier.
   * (email, phone number, whatsapp id, etc.)
   */
  to: string;

  priority: NotificationPriority;

  variables: TVariables;

  /**
   * Optional idempotency key. Without it the notification-service dedupes on a
   * hash of channel, to, template_id and variables.
   */
  dedupe_id?: string;
}
