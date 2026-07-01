/**
 * The generic notification shapes, derived from lifecycle event × direction.
 * One action create fans out to INBOUND_REQUEST + OUTBOUND_REQUEST; a receiver
 * status change fans out to INBOUND_STATUS + OUTBOUND_STATUS. A cancellation is
 * source-initiated (the applicant withdrawing), so it notifies only the
 * receiver with the dedicated WITHDRAWN shape — the canceller needs no email.
 */
export type NotificationShape =
  | 'INBOUND_REQUEST'
  | 'OUTBOUND_REQUEST'
  | 'INBOUND_STATUS'
  | 'OUTBOUND_STATUS'
  | 'WITHDRAWN';
