/**
 * Notification shapes. An action create fans out to INBOUND_REQUEST +
 * OUTBOUND_REQUEST; a status change to INBOUND_STATUS + OUTBOUND_STATUS.
 */
export type NotificationShape =
  | 'INBOUND_REQUEST'
  | 'OUTBOUND_REQUEST'
  | 'INBOUND_STATUS'
  | 'OUTBOUND_STATUS';
