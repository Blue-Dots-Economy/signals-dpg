import { createAuth } from '@dpg/auth';
import { allowed_origins, admin_domains } from '@dpg/config';
import { api, instance, auth, notification } from '@/config';
import { db } from '@api/db/postgres/drizzle_config';
import { redis } from '@api/db/secondary/redis';
import { getNotificationClient } from '@/utils/notificationClient';

export const authInstance = createAuth({
  appName: instance.INSTANCE_NAME ?? 'DPG',
  nodeEnv: instance.INSTANCE_ENV,

  baseURL:
    instance.INSTANCE_ENV === 'development'
      ? `${api.API_DOMAIN}:${api.API_PORT}/api/auth`
      : `${api.API_DOMAIN}/api/auth`,

  secret: auth.AUTH_SECRET,
  apiDomain: api.API_DOMAIN,

  trustedOrigins: allowed_origins,
  adminDomains: admin_domains,

  db: db,
  redis: redis,

  createTestOTP: auth.CREATE_TEST_OTP,
  notificationClient: getNotificationClient(),
  smsTemplateId: notification.SMS_TEMPLATE_ID,
});
