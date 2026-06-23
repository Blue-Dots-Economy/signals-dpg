/**
 * Priority at which a notification should be processed.
 */
export type NotificationPriority = 'realtime' | 'other';

/**
 * Payload sent to the `/notify` endpoint.
 *
 * `variables` MUST conform to the JSON Schema returned
 * by `/providers` for the given `channel`.
 */
export interface NotifyRequest<TVariables extends Record<string, unknown>> {
  /**
   * Notification channel/provider (e.g. email, sms, whatsapp).
   *
   * ⚠️ Do NOT hardcode allowed values.
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

  /**
   * Processing priority.
   */
  priority: NotificationPriority;

  /**
   * Provider-specific variables.
   *
   * Must satisfy the provider JSON schema.
   */
  variables: TVariables;

  /**
   * Optional idempotency key. The notification-service dedupes on this key
   * (defaulting to `${channel}:${to}:${template_id}` when omitted).
   */
  dedupe_id?: string;
}
