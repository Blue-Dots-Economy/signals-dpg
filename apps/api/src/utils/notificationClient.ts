import { createNotificationClient } from '@dpg/notification';
import { notification } from '@/config';

/**
 * The notification client, or undefined when NOTIFICATION_SERVICE_ENDPOINT,
 * _KEY_ID or _SECRET is unset.
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
