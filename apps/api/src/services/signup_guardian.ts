/**
 * Pre-auth, signup-scoped guardian consent (U18 spec, pre-signup phase).
 *
 * For a self-signup MINOR, the account doesn't exist yet at the point the
 * guardian must be captured + OTP-verified — it has to happen BEFORE the
 * ward's own login OTP. There is no session and no user id to key state on,
 * so this whole flow is keyed on the signup identifier (the ward's own email
 * or phone) instead, held in Redis with a short TTL, and only materialized
 * onto the `minor_guardian` / `consent_record` tables once better-auth
 * actually creates the user (see `materializeSignupGuardian`, wired via
 * `afterUserCreate` in `apps/api/src/routes/auth/create_auth.ts`).
 *
 * The Redis key is a hash of the normalized identifier, never the identifier
 * itself — the raw email/phone must not sit in a Redis key.
 */
import { createHash } from 'node:crypto';
import { redis } from '@api/db/secondary/redis';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import { apiConfig } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import { isMinor, guardianConsentRequired } from '@/services/minor';
import { encryptGuardianField } from '@/services/guardian_pii';
import {
  issueGuardianOtp,
  verifyGuardianOtp,
  assertVerifyAttemptAllowed,
  type GuardianContactType,
} from '@/services/guardian_otp';
import { resolveConsentVersion } from '@/services/consent_version';
import { writeEncryptedGuardian, resolveOtpChannel } from '@/services/minor_guardian_repo';

/** The ward's own signup identifier — exactly one of the two. */
export type SignupIdentifier = { email: string } | { phoneNumber: string };

/** Codes this module raises; callers map these to HTTP responses. */
export class SignupGuardianError extends Error {
  constructor(
    public code:
      | 'UNKNOWN_NETWORK'
      | 'NOT_GATED'
      | 'NOT_A_MINOR'
      | 'SAME_CONTACT_NEEDS_ACK'
      | 'INVALID_OTP'
      | 'NO_PENDING_SIGNUP',
  ) {
    super(code);
    this.name = 'SignupGuardianError';
  }
}

const PENDING_TTL_SEC = 1800; // 30 min — long enough to clear an OTP round-trip, short enough to not linger

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
function normalizePhone(value: string): string {
  return value.trim();
}

function normalizeIdentifier(identifier: SignupIdentifier): { type: 'email' | 'phone'; value: string } {
  if ('email' in identifier) return { type: 'email', value: normalizeEmail(identifier.email) };
  return { type: 'phone', value: normalizePhone(identifier.phoneNumber) };
}

function normalizeContact(contact: string, contactType: GuardianContactType): string {
  return contactType === 'email' ? normalizeEmail(contact) : normalizePhone(contact);
}

/** SHA-256 hex of the normalized identifier — never the raw identifier. */
function hashIdentifier(normalizedValue: string): string {
  return createHash('sha256').update(normalizedValue).digest('hex');
}

const pendingKey = (hash: string) => `signup_guardian:pending:${hash}`;
const otpScope = (hash: string) => `signup_guardian:${hash}`;

interface PendingSignupGuardian {
  network: string;
  domain: string;
  birthYear: number;
  birthMonth: number;
  guardianName: string; // already encrypted
  guardianContact: string; // already encrypted — the OTP channel
  guardianContactType: GuardianContactType;
  guardianEmail?: string; // already encrypted, when supplied
  guardianPhone?: string; // already encrypted, when supplied
  guardianDeclarationAccepted: true;
  verified: boolean;
}

async function readPending(hash: string): Promise<PendingSignupGuardian | null> {
  const raw = await redis.get(pendingKey(hash));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingSignupGuardian;
  } catch {
    return null;
  }
}

async function writePending(
  hash: string,
  pending: PendingSignupGuardian,
  ttlSec: number = PENDING_TTL_SEC,
): Promise<void> {
  await redis.set(pendingKey(hash), JSON.stringify(pending), 'EX', ttlSec > 0 ? ttlSec : PENDING_TTL_SEC);
}

export interface StartSignupGuardianInput {
  network: string;
  domain: string;
  identifier: SignupIdentifier;
  birthYear: number;
  birthMonth: number;
  guardianName: string;
  guardianEmail?: string;
  guardianPhone?: string;
  guardianDeclarationAccepted: true;
  sameContactAcknowledged?: boolean;
}

/**
 * Capture + kick off OTP verification for a guardian on behalf of a would-be
 * minor signup. Throws a typed `SignupGuardianError` (or a `GuardianOtpError`
 * bubbled up from `issueGuardianOtp`) for every failure path; never writes
 * partial state on a throw.
 */
export async function startSignupGuardian(input: StartSignupGuardianInput): Promise<void> {
  const served = apiConfig.served_domains.some(
    (binding) => binding.network === input.network && binding.domain === input.domain,
  );
  if (!served) throw new SignupGuardianError('UNKNOWN_NETWORK');

  const networkConfig = await getNetworkConfigById(input.network);
  if (!guardianConsentRequired(networkConfig, input.domain)) {
    throw new SignupGuardianError('NOT_GATED');
  }

  if (!isMinor(input.birthYear, input.birthMonth)) {
    throw new SignupGuardianError('NOT_A_MINOR');
  }

  // Resolve the single OTP channel (phone preferred when both are given).
  const channel = resolveOtpChannel({ guardianEmail: input.guardianEmail, guardianPhone: input.guardianPhone });

  // Warn-and-confirm: neither guardian contact may silently equal the ward's
  // own signup identifier. Not a hard reject — an explicit ack lets it proceed.
  const ident = normalizeIdentifier(input.identifier);
  const sameContact =
    (ident.type === 'email' && !!input.guardianEmail &&
      normalizeContact(input.guardianEmail, 'email') === ident.value) ||
    (ident.type === 'phone' && !!input.guardianPhone &&
      normalizeContact(input.guardianPhone, 'phone') === ident.value);
  if (sameContact && input.sameContactAcknowledged !== true) {
    throw new SignupGuardianError('SAME_CONTACT_NEEDS_ACK');
  }

  const hash = hashIdentifier(ident.value);

  const pending: PendingSignupGuardian = {
    network: input.network,
    domain: input.domain,
    birthYear: input.birthYear,
    birthMonth: input.birthMonth,
    guardianName: encryptGuardianField(input.guardianName),
    guardianContact: encryptGuardianField(channel.contact),
    guardianContactType: channel.contactType,
    guardianEmail: input.guardianEmail ? encryptGuardianField(input.guardianEmail) : undefined,
    guardianPhone: input.guardianPhone ? encryptGuardianField(input.guardianPhone) : undefined,
    guardianDeclarationAccepted: true,
    verified: false,
  };
  await writePending(hash, pending);

  // Issued against the plaintext channel contact (the encrypted blob above is
  // for at-rest storage only) — may throw GuardianOtpError (RATE_LIMITED /
  // NO_OTP_PROVIDER), which the route maps directly.
  await issueGuardianOtp({
    scope: otpScope(hash),
    contact: channel.contact,
    contactType: channel.contactType,
  });
}

export interface VerifySignupGuardianInput {
  identifier: SignupIdentifier;
  otp: string;
}

/**
 * Verify the guardian OTP for a pending signup-scoped guardian capture.
 * Flips the pending record's `verified` flag but does NOT touch any table —
 * materialization onto the ward's user row happens later, once the account
 * actually exists (`materializeSignupGuardian`).
 */
export async function verifySignupGuardian(input: VerifySignupGuardianInput): Promise<void> {
  const ident = normalizeIdentifier(input.identifier);
  const hash = hashIdentifier(ident.value);
  const scope = otpScope(hash);

  const pending = await readPending(hash);
  if (!pending) throw new SignupGuardianError('NO_PENDING_SIGNUP');

  // May throw GuardianOtpError('VERIFY_THROTTLED') — the route maps it.
  await assertVerifyAttemptAllowed(scope);

  const ok = await verifyGuardianOtp({ scope, otp: input.otp });
  if (!ok) throw new SignupGuardianError('INVALID_OTP');

  const ttl = await redis.ttl(pendingKey(hash));
  pending.verified = true;
  await writePending(hash, pending, ttl);
}

export interface MaterializeSignupGuardianUser {
  id: string;
  email?: string | null;
  phoneNumber?: string | null;
}

/**
 * Called from the better-auth `afterUserCreate` hook right after a genuinely
 * new user row is created. Looks up a verified pending signup-guardian
 * capture by the new user's email and/or phone (whichever the signup used),
 * and — only if found and verified — materializes it onto the new user id:
 * the `minor_guardian` row (already-encrypted blobs written directly, never
 * re-encrypted) plus the three U18 consent rows (guardian_declaration
 * source='self', terms + privacy source='guardian'), all in one transaction.
 * The pending Redis key is deleted afterward so it can't be replayed.
 *
 * A no-op (returns without writing anything) for a normal adult/non-gated
 * signup, where no pending capture exists.
 */
export async function materializeSignupGuardian(user: MaterializeSignupGuardianUser): Promise<void> {
  const candidateHashes: string[] = [];
  if (user.email) candidateHashes.push(hashIdentifier(normalizeEmail(user.email)));
  if (user.phoneNumber) candidateHashes.push(hashIdentifier(normalizePhone(user.phoneNumber)));

  for (const hash of candidateHashes) {
    const pending = await readPending(hash);
    if (!pending || !pending.verified) continue;

    const [declVersion, termsVersion, privacyVersion] = await Promise.all([
      resolveConsentVersion({ network: pending.network, category: 'guardian_declaration', variant: 'u18' }),
      resolveConsentVersion({ network: pending.network, category: 'terms', variant: 'u18' }),
      resolveConsentVersion({ network: pending.network, category: 'privacy', variant: 'u18' }),
    ]);
    if (declVersion === null || termsVersion === null || privacyVersion === null) {
      throw new Error(
        `signup_guardian: u18 consent versions are not fully configured for network "${pending.network}"`,
      );
    }

    const acceptedAt = new Date();
    await db.transaction(async (tx) => {
      await writeEncryptedGuardian(
        user.id,
        {
          birthYear: pending.birthYear,
          birthMonth: pending.birthMonth,
          guardianNameEnc: pending.guardianName,
          guardianContactEnc: pending.guardianContact,
          guardianContactType: pending.guardianContactType,
          guardianEmailEnc: pending.guardianEmail ?? null,
          guardianPhoneEnc: pending.guardianPhone ?? null,
        },
        tx,
      );

      await tx.insert(consent_record).values([
        {
          level: 'user',
          consentCategory: 'guardian_declaration',
          userId: user.id,
          network: pending.network,
          brand: null,
          documentVersion: declVersion,
          source: 'self',
          acceptedAt,
          metadata: { variant: 'u18' },
        },
        {
          level: 'user',
          consentCategory: 'terms',
          userId: user.id,
          network: pending.network,
          brand: null,
          documentVersion: termsVersion,
          source: 'guardian',
          acceptedAt,
          metadata: { variant: 'u18' },
        },
        {
          level: 'user',
          consentCategory: 'privacy',
          userId: user.id,
          network: pending.network,
          brand: null,
          documentVersion: privacyVersion,
          source: 'guardian',
          acceptedAt,
          metadata: { variant: 'u18' },
        },
      ]);
    });

    await redis.del(pendingKey(hash));
    return;
  }
  // No verified pending capture for this user — normal adult/non-gated signup.
}
