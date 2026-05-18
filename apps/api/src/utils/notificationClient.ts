import { createNotificationClient } from '@dpg/notification';
import { notification } from '@/config';

/**
 * Creates and returns a notification client if all required configuration is present.
 * Returns undefined if any required environment variables are missing.
 * 
 * Required configuration:
 * - NOTIFICATION_SERVICE_ENDPOINT
 * - NOTIFICATION_SERVICE_KEY_ID
 * - NOTIFICATION_SERVICE_SECRET
 */
export const getNotificationClient = () => {
  if (
    notification.NOTIFICATION_SERVICE_ENDPOINT &&
    notification.NOTIFICATION_SERVICE_KEY_ID &&
    notification.NOTIFICATION_SERVICE_SECRET
  ) {
    return createNotificationClient({
      baseUrl: notification.NOTIFICATION_SERVICE_ENDPOINT,
      keyId: notification.NOTIFICATION_SERVICE_KEY_ID,
      secret: notification.NOTIFICATION_SERVICE_SECRET,
    });
  }
  return undefined;
};
