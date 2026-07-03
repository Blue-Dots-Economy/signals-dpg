/**
 * The four generic notification shapes, derived from lifecycle event ×
 * direction. One action create fans out to INBOUND_REQUEST + OUTBOUND_REQUEST;
 * one status change fans out to INBOUND_STATUS + OUTBOUND_STATUS.
 */
export type NotificationShape =
  | 'INBOUND_REQUEST'
  | 'OUTBOUND_REQUEST'
  | 'INBOUND_STATUS'
  | 'OUTBOUND_STATUS';
