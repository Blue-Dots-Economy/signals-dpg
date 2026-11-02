import { randomInt, createHash } from 'node:crypto';
import { redis } from '@api/db/secondary/redis';
import { getNotificationClient } from '@/utils/notificationClient';
import { authConfig, supportConfig, notification } from '@/config';
import { renderOrgList } from '@/notifications/email/shells';
import { getDefaultEmailSender } from '@/notifications/email/dispatch_email';
import { incrWithinWindow } from '@/utils/rate_window';

/** Codes the primitive raises; callers map these to HTTP responses. */
export class GuardianOtpError extends Error {
  constructor(public code: 'RATE_LIMITED' | 'NO_OTP_PROVIDER' | 'VERIFY_THROTTLED') {
    super(code);
    this.name = 'GuardianOtpError';
  }
}

export type GuardianContactType = 'phone' | 'email';

/**
 * The parent-facing scenario a guardian OTP is issued for. Selects the email
 * case (`guardian.<kind>`) and its copy; the code, TTL and throttles are the
 * same for every scenario, and SMS always uses the one generic OTP template.
 * For actions, `actionType` comes from the interaction in `network.json`.
 */
export type GuardianOtpScenario =
  | { kind: 'account' } // ward wants to create an account (pre-auth signup)
  | { kind: 'profile' } // ward wants to create a profile
  | { kind: 'action'; actionType: string; stage: 'initiate' | 'accept' } // connect/apply/etc.
  // One OTP authorises a whole batch of actions; the email lists every
  // provider org. `jobs` picks "jobs" vs "opportunities" in the copy.
  | {
      kind: 'action_bulk';
      actionType: string;
      stage: 'initiate' | 'accept';
      providerOrgNames: string[];
      jobs: boolean;
    };

/** Extra template variables per scenario (parent name, domain, provider org). */
export type GuardianOtpVariables = Record<string, string>;

/** Dispatch seam — injected so the core is testable without the notifier. */
export type OtpSend = (args: {
  contact: string;
  contactType: GuardianContactType;
  otp: string;
  scenario?: GuardianOtpScenario;
  variables?: GuardianOtpVariables;
}) => Promise<void>;

export const GUARDIAN_OTP_TTL_SEC = 600; // nonce lifetime (10 min; the email copy states it)
export const GUARDIAN_OTP_MAX_PER_WINDOW = 3; // sends allowed per scope per window
export const GUARDIAN_OTP_CONTACT_MAX_PER_WINDOW = 5; // sends allowed per guardian contact per window
export const GUARDIAN_OTP_WINDOW_SEC = 300; // rate-limit window (5 min)
export const GUARDIAN_OTP_VERIFY_MAX = 5; // verify attempts per window
export const GUARDIAN_OTP_VERIFY_WINDOW_SEC = 300;

const codeKey = (scope: string) => `guardian_otp:code:${scope}`;
const rateKey = (scope: string) => `guardian_otp:rl:${scope}`;
const verifyRateKey = (scope: string) => `guardian_otp:vrl:${scope}`;
// Per-guardian-contact send counter. The scope limit is keyed on the ward, and
// the public signup route lets a caller rotate ward identifiers to spam one
// contact past it. The contact is hashed so no PII lands in a Redis key.
const contactRateKey = (contact: string, contactType: GuardianContactType) =>
  `guardian_otp:crl:${contactType}:${createHash('sha256').update(contact).digest('hex')}`;

/**
 * Maps a `GuardianOtpError` to its HTTP reply shape, or null when `err` isn't
 * one (the caller falls back to a 500).
 */
export function guardianOtpErrorReply(
  err: unknown,
): { status: number; error: string; message: string } | null {
  if (!(err instanceof GuardianOtpError)) return null;
  switch (err.code) {
    case 'RATE_LIMITED':
      return { status: 429, error: 'OTP_RATE_LIMITED', message: 'Too many OTP requests; try again shortly' };
    case 'NO_OTP_PROVIDER':
      return { status: 503, error: 'OTP_PROVIDER_UNAVAILABLE', message: 'No OTP channel configured for this instance' };
    case 'VERIFY_THROTTLED':
      return { status: 429, error: 'OTP_VERIFY_THROTTLED', message: 'Too many attempts; try again shortly' };
  }
}

/** sha256 hex of an OTP; Redis stores this, never the plaintext code. */
const hashOtp = (otp: string) => createHash('sha256').update(otp).digest('hex');

function generateOtp(): string {
  // CREATE_TEST_OTP: fixed code for dev/test; config refuses it in production.
  if (authConfig.create_test_otp) return '000000';
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Issues a guardian OTP for `scope` (e.g. a user id + purpose): rate-limits,
 * stores the hashed code with a short TTL, and dispatches via `send`. Throws
 * `GuardianOtpError('RATE_LIMITED')` before sending when a scope or contact
 * window max is hit.
 */
export async function issueGuardianOtp(args: {
  scope: string;
  contact: string;
  contactType: GuardianContactType;
  scenario?: GuardianOtpScenario;
  variables?: GuardianOtpVariables;
  send?: OtpSend;
}): Promise<void> {
  const count = await incrWithinWindow(rateKey(args.scope), GUARDIAN_OTP_WINDOW_SEC);
  if (count > GUARDIAN_OTP_MAX_PER_WINDOW) {
    throw new GuardianOtpError('RATE_LIMITED');
  }

  // Per-contact cap catches ward-identifier rotation aimed at one victim contact.
  const contactCount = await incrWithinWindow(
    contactRateKey(args.contact, args.contactType),
    GUARDIAN_OTP_WINDOW_SEC,
  );
  if (contactCount > GUARDIAN_OTP_CONTACT_MAX_PER_WINDOW) {
    throw new GuardianOtpError('RATE_LIMITED');
  }

  const otp = generateOtp();
  // Only the hash is stored, so Redis read access cannot expose a live OTP.
  await redis.set(codeKey(args.scope), hashOtp(otp), 'EX', GUARDIAN_OTP_TTL_SEC);
  // Test-OTP mode skips dispatch; the fixed code is already known.
  if (authConfig.create_test_otp) return;
  const send = args.send ?? defaultGuardianOtpSend;
  await send({
    contact: args.contact,
    contactType: args.contactType,
    otp,
    scenario: args.scenario,
    variables: args.variables,
  });
}

// Atomic compare-and-delete on the stored hash, so two concurrent verifies of
// one code cannot both succeed. A non-match leaves the code for a retry.
const CONSUME_IF_MATCH = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

/**
 * Verifies and consumes a guardian OTP. Single-use: a correct code is deleted.
 * Returns false for wrong, expired or missing codes.
 */
export async function verifyGuardianOtp(args: {
  scope: string;
  otp: string;
}): Promise<boolean> {
  const consumed = (await redis.eval(CONSUME_IF_MATCH, 1, codeKey(args.scope), hashOtp(args.otp))) as number;
  return consumed === 1;
}

/**
 * Throttles verify attempts per scope against brute force of the 6-digit
 * code. Throws VERIFY_THROTTLED past the window max. Call before
 * verifyGuardianOtp.
 */
export async function assertVerifyAttemptAllowed(scope: string): Promise<void> {
  const count = await incrWithinWindow(verifyRateKey(scope), GUARDIAN_OTP_VERIFY_WINDOW_SEC);
  if (count > GUARDIAN_OTP_VERIFY_MAX) {
    throw new GuardianOtpError('VERIFY_THROTTLED');
  }
}

// WhatsApp is not wired for guardian OTPs; do not add it here.
const CHANNEL_BY_CONTACT_TYPE: Record<GuardianContactType, 'sms' | 'email'> = {
  phone: 'sms',
  email: 'email',
};

// SMS uses the instance's one generic DLT-approved OTP template
// (`SMS_TEMPLATE_ID`, default `login_otp`) with `{ message: otp }`. It carries
// only the code; parent-facing copy is email-only.
const GENERIC_SMS_TEMPLATE_ID = 'login_otp';

/**
 * Maps a guardian OTP scenario to its email case and variables. Fallbacks are
 * supplied here because the copy file has no conditionals: every placeholder
 * must get a value.
 */
export function buildGuardianEmailDispatch(args: {
  scenario?: GuardianOtpScenario;
  otp: string;
  variables: GuardianOtpVariables;
  teamName: string;
}): { caseId: string; variables: Record<string, string> } {
  const { scenario, otp, variables, teamName } = args;
  if (!scenario) {
    return { caseId: 'otp.generic', variables: { otp } };
  }
  const vars: Record<string, string> = {
    otp,
    parentName: variables.parentName || 'there',
    domain: variables.domain || teamName,
    org: variables.providerOrgName || 'the organisation',
    teamName,
  };
  if (scenario.kind === 'action_bulk') {
    vars.noun = scenario.jobs ? 'jobs' : 'opportunities';
    vars.orgList = renderOrgList(scenario.providerOrgNames);
  }
  return { caseId: `guardian.${scenario.kind}`, variables: vars };
}

/**
 * Default dispatch: picks the channel from the contact type and sends via the
 * notification client. Throws NO_OTP_PROVIDER when no provider is configured,
 * so a guardian-required domain never silently skips verification.
 *
 * Email goes through `dispatchEmail` with the case from
 * `buildGuardianEmailDispatch` (copy lives in the email messages file). SMS
 * sends the generic OTP template; notification-service renders the body.
 */
export const defaultGuardianOtpSend: OtpSend = async ({ contact, contactType, otp, scenario, variables }) => {
  const client = getNotificationClient();
  if (!client) {
    throw new GuardianOtpError('NO_OTP_PROVIDER');
  }
  const channel = CHANNEL_BY_CONTACT_TYPE[contactType];

  if (channel === 'email') {
    const sender = getDefaultEmailSender();
    if (!sender) {
      throw new GuardianOtpError('NO_OTP_PROVIDER');
    }
    const teamName = supportConfig.teamName ?? 'Blue Dots';
    const dispatch = buildGuardianEmailDispatch({
      scenario,
      otp,
      variables: variables ?? {},
      teamName,
    });
    // Guardian cases are critical, so dispatchEmail rethrows on failure.
    await sender.dispatchEmail({
      caseId: dispatch.caseId,
      to: contact,
      fromName: teamName,
      variables: dispatch.variables,
    });
    return;
  }

  await client.notify({
    channel: 'sms',
    template_id: notification.SMS_TEMPLATE_ID || GENERIC_SMS_TEMPLATE_ID,
    to: contact,
    priority: 'realtime',
    variables: { message: otp },
  });
};
