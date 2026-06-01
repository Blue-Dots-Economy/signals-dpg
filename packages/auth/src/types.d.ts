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
  /**
   * Predicate used by /unified-otp/join-network to reject bindings the host
   * doesn't serve. Wired by the host (apps/api) to apiConfig.served_domains.
   */
  isServedBinding?: (network: string, domain: string) => boolean;
}
