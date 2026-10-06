import { randomInt, createHash } from 'node:crypto';
import { redis } from '@api/db/secondary/redis';
import { guardianEvent, NotifyTransportError, type NotifyEvent } from '@dpg/notification';
import { normalizeE164Phone } from '@dpg/schemas';
import { getNotificationClient } from '@/utils/notificationClient';
import { authConfig, supportConfig } from '@/config';
// The fixed-window counter used by the send rate-limit and the verify throttle
// below; shared with the support route since #551.
import { incrWithinWindow } from '@/utils/rate_window';

/** Codes the primitive raises; callers map these to HTTP responses. */
export class GuardianOtpError extends Error {
  constructor(
    public code: 'RATE_LIMITED' | 'NO_OTP_PROVIDER' | 'VERIFY_THROTTLED',
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = 'GuardianOtpError';
  }
}

export type GuardianContactType = 'phone' | 'email';

/**
 * The parent-facing scenario a guardian OTP is issued for (#294). Its `kind`
 * selects the `guardian.otp.<kind>` event, and so the copy the guardian sees.
 * Distinct from the OTP mechanics — the code/TTL/throttles are identical across
 * scenarios. `actionType` and `stage` do not change the event: every action
 * shares the `guardian.otp.action` copy.
 */
export type GuardianOtpScenario =
  | { kind: 'account' } // ward wants to create an account (pre-auth signup)
  | { kind: 'profile' } // ward wants to create a profile
  | { kind: 'action'; actionType: string; stage: 'initiate' | 'accept' } // connect/apply/etc.
  // Bulk action (#393): the ward performs many actions at once; one OTP
  // authorises the whole batch and the email lists every provider org.
  // `jobs` picks the copy (Bluedots "jobs" vs generic "opportunities"). SMS is
  // unaffected — it only carries the code, so the org list is email-only.
  | {
      kind: 'action_bulk';
      actionType: string;
      stage: 'initiate' | 'accept';
      providerOrgNames: string[];
      jobs: boolean;
    };

/** Extra template variables per scenario (parent name, domain, provider org). */
export type GuardianOtpVariables = Record<string, string>;

/**
 * Where a failed send is reported. `FastifyBaseLogger` satisfies it. The
 * routes map `GuardianOtpError` to a reply without logging it, so the send
 * logs its own failure reason here.
 */
export interface GuardianOtpLog {
  error: (details: Record<string, unknown>, message: string) => void;
}

/**
 * The fallback `GuardianOtpLog` for a call with no request logger: one
 * pino-shaped line (level 50 = error) on stdout, beside the app's own logs.
 * Every route passes `request.log`, so this only covers direct callers.
 */
const fallbackGuardianOtpLog: GuardianOtpLog = {
  error: (details, message) => {
    process.stdout.write(JSON.stringify({ level: 50, time: Date.now(), msg: message, ...details }) + '\n');
  },
};

/** Dispatch seam — injected so the core is testable without the notifier. */
export type OtpSend = (args: {
  contact: string;
  contactType: GuardianContactType;
  otp: string;
  scenario?: GuardianOtpScenario;
  variables?: GuardianOtpVariables;
  log?: GuardianOtpLog;
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
// A phone is hashed in its canonical E.164 form (R14), so two spellings of one
// number share a counter.
const contactRateKey = (contact: string, contactType: GuardianContactType) => {
  const canonical = contactType === 'phone' ? (normalizeE164Phone(contact) ?? contact.trim()) : contact;
  return `guardian_otp:crl:${contactType}:${createHash('sha256').update(canonical).digest('hex')}`;
};

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
  log?: GuardianOtpLog;
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
    ...(args.log ? { log: args.log } : {}),
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

/** The failure reason when a stored guardian phone cannot be made E.164. */
const GUARDIAN_PHONE_NOT_E164 = 'guardian_phone_not_e164';

/** The R5 filler when a bulk guardian OTP names no organisation. */
const NO_ORGS = 'the selected organisations';

/**
 * The provider organisations as one plain-text phrase: `A`, `A and B`,
 * `A, B and C` (F2-2). The notification service has no loops, so the list the
 * email used to render as HTML is now a single text variable, escaped by NS.
 */
export function formatOrgList(names: string[]): string {
  if (names.length === 0) return NO_ORGS;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Maps a guardian OTP scenario to its `/v1/notify` event. Pure.
 *
 * - `to` carries the one contact point the guardian gave; the policy
 *   (`first_available`: email, then the SMS `login_otp` template) uses it.
 * - The code travels only in `variables.message`, the name the SMS template
 *   fixes and the email templates share (F2-8).
 * - Fallback values are supplied here because the copy has no conditionals:
 *   every declared placeholder always gets a value.
 * - No idempotency key: every issue is a new challenge with a new code, so two
 *   sends must never collapse into one (R12).
 */
export function buildGuardianOtpEvent(args: {
  contact: string;
  contactType: GuardianContactType;
  otp: string;
  scenario?: GuardianOtpScenario;
  variables: GuardianOtpVariables;
  teamName: string;
}): NotifyEvent {
  const { contact, contactType, otp, scenario, variables, teamName } = args;
  // Capture stores E.164 already; this catches a legacy row stored before it
  // did. A phone that still is not E.164 is never sent (NS would refuse it).
  const phone = contactType === 'phone' ? normalizeE164Phone(contact) : null;
  if (contactType === 'phone' && !phone) {
    throw new GuardianOtpError('NO_OTP_PROVIDER', { cause: new Error(GUARDIAN_PHONE_NOT_E164) });
  }
  const event = (eventType: string, vars: Record<string, string>): NotifyEvent => ({
    event_type: eventType,
    domain: null,
    to: phone ? { phone } : { email: contact },
    variables: vars,
    priority: 'urgent',
  });
  if (!scenario) {
    return event(guardianEvent('generic'), { message: otp });
  }
  const vars: Record<string, string> = {
    message: otp,
    parentName: variables.parentName || 'there',
    domain: variables.domain || teamName,
    org: variables.providerOrgName || 'the organisation',
    teamName,
  };
  if (scenario.kind === 'action_bulk') {
    vars.noun = scenario.jobs ? 'jobs' : 'opportunities';
    vars.orgList = formatOrgList(scenario.providerOrgNames);
  }
  return event(guardianEvent(scenario.kind), vars);
}

/**
 * Default dispatch: one `guardian.otp.*` event to the notification service,
 * which picks the channel from the contact point. Hard-fails with
 * `NO_OTP_PROVIDER` (503 at the route) when no client is configured, the
 * service refuses the event, it cannot be reached, or a stored phone cannot be
 * made E.164 — a guardian-required domain must not silently skip verification.
 *
 * Each failure is logged here (`log`, else a pino-shaped stdout line) with the
 * event type and the service's status/error, the transport kind, or the
 * reason — never the code, the contact or a variable — because the routes
 * turn the error into a reply without logging it.
 */
export const defaultGuardianOtpSend: OtpSend = async ({ contact, contactType, otp, scenario, variables, log }) => {
  const logger = log ?? fallbackGuardianOtpLog;
  const eventType = guardianEvent(scenario?.kind ?? 'generic');
  const client = getNotificationClient();
  if (!client) {
    throw new GuardianOtpError('NO_OTP_PROVIDER');
  }
  let event: NotifyEvent;
  try {
    event = buildGuardianOtpEvent({
      contact,
      contactType,
      otp,
      scenario,
      variables: variables ?? {},
      teamName: supportConfig.teamName ?? 'Blue Dots',
    });
  } catch (err) {
    if (err instanceof GuardianOtpError) {
      logger.error(
        { event_type: eventType, reason: GUARDIAN_PHONE_NOT_E164 },
        'guardian otp: stored phone is not E.164; not sent',
      );
    }
    throw err;
  }

  let result;
  try {
    result = await client.send(event);
  } catch (err) {
    if (err instanceof NotifyTransportError) {
      logger.error(
        { event_type: event.event_type, kind: 'transport', error: err.message },
        'guardian otp: ns_unreachable',
      );
      throw new GuardianOtpError('NO_OTP_PROVIDER', { cause: err });
    }
    throw err;
  }
  if (!result.ok) {
    logger.error(
      { event_type: event.event_type, status: result.status, error: result.error },
      'guardian otp: ns_rejected',
    );
    throw new GuardianOtpError('NO_OTP_PROVIDER', {
      cause: new Error(`ns_rejected ${event.event_type}: ${result.status} ${result.error}`),
    });
  }
};
