import { randomInt, createHash } from 'node:crypto';
import { redis } from '@api/db/secondary/redis';
import { getNotificationClient } from '@/utils/notificationClient';
import { authConfig, supportConfig, notification } from '@/config';
import { renderGuardianOtpEmail } from '@/services/guardian_otp_email';

/** Codes the primitive raises; callers map these to HTTP responses. */
export class GuardianOtpError extends Error {
  constructor(public code: 'RATE_LIMITED' | 'NO_OTP_PROVIDER' | 'VERIFY_THROTTLED') {
    super(code);
    this.name = 'GuardianOtpError';
  }
}

export type GuardianContactType = 'phone' | 'email';

/**
 * The parent-facing scenario a guardian OTP is issued for (#294). Selects the
 * notification template + the copy the guardian sees. Distinct from the OTP
 * mechanics — the code/TTL/throttles are identical across scenarios.
 *
 * For actions, `actionType` is taken straight from `network.json` (the gate
 * passes the interaction's own action type) — NOT hardcoded — so any action a
 * network defines derives its template automatically:
 *   `guardian_otp_<actionType>[_accept]_sms`.
 */
export type GuardianOtpScenario =
  | { kind: 'account' } // ward wants to create an account (pre-auth signup)
  | { kind: 'profile' } // ward wants to create a profile
  | { kind: 'action'; actionType: string; stage: 'initiate' | 'accept' }; // connect/apply/etc.

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

export const GUARDIAN_OTP_TTL_SEC = 600; // nonce lifetime (10 min — matches template copy, #294)
export const GUARDIAN_OTP_MAX_PER_WINDOW = 3; // sends allowed per scope per window
export const GUARDIAN_OTP_CONTACT_MAX_PER_WINDOW = 5; // sends allowed per guardian contact per window
export const GUARDIAN_OTP_WINDOW_SEC = 300; // rate-limit window (5 min)
export const GUARDIAN_OTP_VERIFY_MAX = 5; // verify attempts per window
export const GUARDIAN_OTP_VERIFY_WINDOW_SEC = 300;

const codeKey = (scope: string) => `guardian_otp:code:${scope}`;
const rateKey = (scope: string) => `guardian_otp:rl:${scope}`;
const verifyRateKey = (scope: string) => `guardian_otp:vrl:${scope}`;
// Per-guardian-CONTACT send counter. The scope rate-limit is keyed on the ward
// (e.g. ward id / signup identifier), so on the public signup route — where the
// caller supplies the guardian contact freely — an attacker can rotate ward
// identifiers to spam one victim number/email past the scope cap. Hash the
// contact so no PII lands in a Redis key.
const contactRateKey = (contact: string, contactType: GuardianContactType) =>
  `guardian_otp:crl:${contactType}:${createHash('sha256').update(contact).digest('hex')}`;

/**
 * Fixed-window counter: increment `key`, set the window TTL on the first hit,
 * return the running count. Shared by the send rate-limit and the verify
 * throttle — the caller decides the max + which error to throw.
 */
async function incrWithinWindow(key: string, windowSec: number): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSec);
  return count;
}

/**
 * Map a `GuardianOtpError` to its HTTP reply shape ({status, error, message}),
 * or null when `err` isn't one (caller falls back to a 500). Reused by every
 * consent route that issues/verifies a guardian OTP so the status ladder isn't
 * hand-rolled per handler.
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

/** sha256 hex of an OTP — what we persist in Redis (never the plaintext code). */
const hashOtp = (otp: string) => createHash('sha256').update(otp).digest('hex');

function generateOtp(): string {
  // Dev/test bypass (CREATE_TEST_OTP): fixed code so the guardian flow is
  // exercisable without a notifier. Guarded against production in config.
  if (authConfig.create_test_otp) return '000000';
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Issue a guardian OTP for `scope` (e.g. a user id + purpose): rate-limit,
 * store the nonce with a short TTL, dispatch via `send`. Throws
 * `GuardianOtpError('RATE_LIMITED')` before sending when the window max is hit.
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
  // Store only a hash of the code — a Redis dump / read-access then can't expose
  // a live OTP. The plaintext code is still what gets dispatched to the guardian.
  await redis.set(codeKey(args.scope), hashOtp(otp), 'EX', GUARDIAN_OTP_TTL_SEC);
  // In test-OTP mode skip the real dispatch — no notifier is required and the
  // fixed code is already known to the tester.
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

/**
 * Verify + consume a guardian OTP. Single-use: a correct code is deleted so it
 * cannot be replayed. Returns false for wrong/expired/missing codes.
 */
// Atomic compare-and-consume: delete the stored code ONLY if it matches the
// submitted one, in a single round-trip. Prevents the get-then-del race where
// two concurrent verifies of the same code both succeed (double consent/action).
// A non-match leaves the code in place so the ward can retry within its TTL.
// Compares HASHES — the stored value is sha256(otp), so the caller hashes the
// submitted code before this runs.
const CONSUME_IF_MATCH = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

export async function verifyGuardianOtp(args: {
  scope: string;
  otp: string;
}): Promise<boolean> {
  const consumed = (await redis.eval(CONSUME_IF_MATCH, 1, codeKey(args.scope), hashOtp(args.otp))) as number;
  return consumed === 1;
}

/**
 * Throttle verify attempts per scope (brute-force guard — the core OTP is a
 * 6-digit space). Throws VERIFY_THROTTLED past the window max. Call before
 * verifyGuardianOtp on the HTTP boundary.
 */
export async function assertVerifyAttemptAllowed(scope: string): Promise<void> {
  const count = await incrWithinWindow(verifyRateKey(scope), GUARDIAN_OTP_VERIFY_WINDOW_SEC);
  if (count > GUARDIAN_OTP_VERIFY_MAX) {
    throw new GuardianOtpError('VERIFY_THROTTLED');
  }
}

// Notification channel per guardian contact type (spec D7). WhatsApp is not
// wired — do not add it here.
const CHANNEL_BY_CONTACT_TYPE: Record<GuardianContactType, 'sms' | 'email'> = {
  phone: 'sms',
  email: 'email',
};

// SMS uses the ONE generic DLT-approved OTP template the instance already has
// (`SMS_TEMPLATE_ID`, default `login_otp` — same as login). It only renders the
// code, so there are no per-scenario SMS templates and no parent-facing SMS copy
// — that lives in the email. Variable is `{ message: otp }`, matching login.
const GENERIC_SMS_TEMPLATE_ID = 'login_otp';

/**
 * Default dispatch: pick the channel from the guardian's contact type and send
 * via the shared notification client. Hard-fails when no provider is
 * configured — a guardian-required domain must not silently skip verification.
 *
 * Email: the body is rendered IN-REPO (`renderGuardianOtpEmail`, #294 copy) and
 * shipped via the generic `basic_email` template — same convention as the login
 * OTP + action emails, so the copy lives in signals. SMS: the DLT-approved body
 * lives in the notification service, so we send a per-scenario `template_id`
 * plus variables and let it render.
 */
export const defaultGuardianOtpSend: OtpSend = async ({ contact, contactType, otp, scenario, variables }) => {
  const client = getNotificationClient();
  if (!client) {
    throw new GuardianOtpError('NO_OTP_PROVIDER');
  }
  const channel = CHANNEL_BY_CONTACT_TYPE[contactType];

  if (channel === 'email') {
    const teamName = supportConfig.teamName ?? 'Blue Dots';
    const { subject, html } = scenario
      ? renderGuardianOtpEmail({ scenario, otp, variables: variables ?? {}, teamName })
      : {
          subject: 'Your One-Time Password (OTP)',
          html: `<p>Use this OTP: <b>${otp}</b></p><p>This OTP is valid for 10 minutes. Do not share it with anyone.</p>`,
        };
    await client.notify({
      channel: 'email',
      template_id: 'basic_email',
      to: contact,
      priority: 'realtime',
      variables: {
        fromName: teamName,
        fromEmail: supportConfig.fromEmail ?? '',
        replyTo: supportConfig.fromEmail ?? '',
        subject,
        html,
      },
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
