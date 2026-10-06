import { NotifyTransportError, type NotifyEvent, type NotifyResult } from '@dpg/notification';

/** Posts one event to the notification service (`NotificationClient.send`). */
export type SendEvent = (event: NotifyEvent) => Promise<NotifyResult>;

/**
 * Sends a best-effort event and reports whether the service accepted it.
 *
 * - A refusal (`ok: false`, e.g. a `422 no_policy` configuration error) is
 *   logged as `ns_rejected` with the service's error code, and never retried.
 * - A transport failure (network, timeout, no token) is logged as
 *   `ns_unreachable`.
 *
 * Both return `false` so the caller carries on: a best-effort notification
 * never fails the action that triggered it. Any other error is a defect and is
 * rethrown for the caller's own catch-all.
 *
 * The log carries the event type, the outcome and the caller's `meta` only —
 * never the recipient or a variable value.
 */
export async function sendBestEffort(
  send: SendEvent,
  event: NotifyEvent,
  log: (message: string, meta: Record<string, unknown>) => void,
  meta: Record<string, unknown> = {},
): Promise<boolean> {
  let result: NotifyResult;
  try {
    result = await send(event);
  } catch (err) {
    if (err instanceof NotifyTransportError) {
      log('ns_unreachable', { event_type: event.event_type, error: err.message, ...meta });
      return false;
    }
    throw err;
  }
  if (result.ok) return true;
  log('ns_rejected', {
    event_type: event.event_type,
    status: result.status,
    error: result.error,
    kind: result.kind,
    ...meta,
  });
  return false;
}
