/**
 * The request and result shapes of the notification-service `POST /v1/notify`
 * endpoint.
 *
 * Signals sends an *event* — what happened, to whom, with which values — and the
 * notification service owns everything else: the policy that turns an event
 * into channels, the templates, the copy and the vendor. So there is no
 * `channel`, `template_key`, subject or HTML here.
 */

/** Delivery priority. Guardian OTP and welcome are `urgent`; most sends are `normal`. */
export type NotifyPriority = 'urgent' | 'normal' | 'bulk';

export interface NotifyAttachment {
  filename: string;
  contentType: string;
  /** Base64-encoded file contents. */
  data: string;
}

export interface NotifyEvent {
  /** Event name, built with the helpers in `events.ts`. */
  event_type: string;
  /** The recipient's network domain id, or `null` for events with no recipient domain. */
  domain?: string | null;
  /** The contact points the recipient has. The service drops channels without one. */
  to: { email?: string; phone?: string };
  variables: Record<string, string | number | boolean>;
  /** Defaults to `normal` when omitted. */
  priority?: NotifyPriority;
  idempotency_key?: string;
  correlation_id?: string;
  cc?: string[];
  reply_to?: string;
  attachments?: NotifyAttachment[];
}

export type NotifyResult =
  | {
      ok: true;
      status: 200 | 202;
      body: { notification_event_id: string; correlation_id: string };
    }
  | {
      ok: false;
      status: number;
      /** The service's `error` code, or `http_<status>` when the body carries none. */
      error: string;
      /** `configuration` for a missing policy/template; `caller` for a bad request. */
      kind?: 'caller' | 'configuration';
    };

/**
 * The send could not reach a verdict from the service: a network failure, a
 * timeout, or no access token. The message names the cause only — never the
 * token, the recipient or a variable value.
 */
export class NotifyTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NotifyTransportError';
  }
}
