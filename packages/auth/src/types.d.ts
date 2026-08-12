import type { NotificationClient } from 'notification';

export type NodeEnv = 'development' | 'production';

/** Minimal shape `afterUserCreate` needs — a structural subset of better-auth's user row. */
export interface AfterUserCreateUser {
  id: string;
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

  /**
   * Central email dispatch (#529), injected by the app so copy/templates stay
   * out of this package. caseId keys into the app's email case registry.
   * When absent (no notification client / tests), the console fallback below
   * is used instead. login.otp MUST rethrow on failure (fail-loud OTP, #1.14);
   * welcome is best-effort and never throws in the app's implementation.
   */
  sendEmail?: (args: {
    caseId: 'login.otp' | 'welcome';
    to: string;
    fromName: string;
    variables: Record<string, string>;
  }) => Promise<void>;

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
