import type { NotificationClient } from 'notification';

export type NodeEnv = 'development' | 'production';

/** Minimal shape `afterUserCreate` needs — a structural subset of better-auth's user row. */
export interface AfterUserCreateUser {
  id: string;
  /** Used to address the welcome notifications. Always set by the OTP create. */
  name: string;
  email?: string | null;
  phoneNumber?: string | null;
}

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

  /**
   * Optional post-signup hook, fired only for genuinely new users (right
   * after the unified-OTP plugin creates the row). Used to materialize
   * pre-auth signup state (e.g. the U18 signup-guardian flow, keyed on the
   * signup identifier before the account existed) onto the new user id.
   * Errors are caught and logged by `createAuth` — a failure here must never
   * block signup or surface to the caller.
   */
  afterUserCreate?: (data: { user: AfterUserCreateUser }) => Promise<void>;
}
