import type { NotificationClient } from 'notification';

export type NodeEnv = 'development' | 'production';

export interface AuthRuntimeConfig {
  appName: string;
  nodeEnv: NodeEnv;

  baseURL: string;
  secret: string;

  apiDomain: string;

  trustedOrigins: string[];
  adminDomains: string[];
  db: DrizzleDatabase;
  redis: Redis;

  createTestOTP?: boolean;
  notificationClient?: NotificationClient;
  smsTemplateId?: string;

  allowSelfSignup: boolean;
  loginChannels: ('email' | 'phone')[];
}
