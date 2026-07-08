import { APIError } from 'better-auth/api';

export type LoginChannel = 'email' | 'phone';

/**
 * Rejects a request whose identifier channel is not enabled for this instance.
 * Applied at the top of the OTP endpoints so a disallowed channel is blocked
 * before any OTP is generated.
 */
export function assertChannelAllowed(
  identifier: { email?: string | null; phoneNumber?: string | null },
  loginChannels: LoginChannel[]
): void {
  if (identifier.phoneNumber && !loginChannels.includes('phone')) {
    throw new APIError('BAD_REQUEST', {
      message: 'Phone login is not enabled on this instance.',
      code: 'LOGIN_CHANNEL_DISABLED',
    });
  }
  if (identifier.email && !loginChannels.includes('email')) {
    throw new APIError('BAD_REQUEST', {
      message: 'Email login is not enabled on this instance.',
      code: 'LOGIN_CHANNEL_DISABLED',
    });
  }
}

/** True when the email's domain is one of the configured admin domains. */
export function isAdminDomainEmail(
  email: string | null | undefined,
  adminByDomain: string[] | undefined
): boolean {
  if (!email || !Array.isArray(adminByDomain)) return false;
  const domain = email.split('@')[1];
  return !!domain && adminByDomain.includes(domain);
}

/**
 * Authoritative self-signup gate. When signup is gated, refuses new-user
 * creation unless the identifier is an admin-domain email (admin bootstrap).
 * Called at the point new-user creation would occur (requestOtp + verifyOtp).
 */
export function assertSelfSignupAllowed(args: {
  allowSelfSignup: boolean;
  email: string | null | undefined;
  adminByDomain: string[] | undefined;
}): void {
  if (args.allowSelfSignup) return;
  if (isAdminDomainEmail(args.email, args.adminByDomain)) return;
  throw new APIError('FORBIDDEN', {
    message:
      'Self sign-up is disabled on this instance. Contact your aggregator to get onboarded.',
    code: 'SELF_SIGNUP_DISABLED',
  });
}
