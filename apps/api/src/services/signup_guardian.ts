/**
 * Pre-auth guardian consent for a self-signup minor.
 *
 * The guardian is captured and OTP-verified before the ward's account exists,
 * so there is no user id: state is keyed on the ward's signup identifier
 * (email or phone) in Redis with a short TTL, and written to `minor_guardian` /
 * `consent_record` when Keycloak provisioning first creates the local user
 * (`materializeSignupGuardian`, called from `services/auth/provisioning.ts`).
 *
 * The Redis key is a hash of the normalized identifier; the raw email/phone
 * must not appear in a Redis key.
 */
import { createHash } from 'node:crypto';
import { redis } from '@api/db/secondary/redis';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import { apiConfig } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import { isMinor, guardianConsentRequired } from '@/services/minor';
import { encryptGuardianField, guardianRef } from '@/services/guardian_pii';
import {
  issueGuardianOtp,
  verifyGuardianOtp,
  assertVerifyAttemptAllowed,
  type GuardianContactType,
} from '@/services/guardian_otp';
import { resolveConsentVersion } from '@/services/consent_version';
import { guardianUserConsentRow } from '@/services/guardian_consent_rows';
import {
  writeEncryptedGuardian,
  assertWardLimitWithLock,
  resolveOtpChannel,
  isGuardianWardLimitReached,
  guardianContactMatchesWard,
  setWardAge,
} from '@/services/minor_guardian_repo';

/** The ward's own signup identifier — exactly one of the two. */
export type SignupIdentifier = { email: string } | { phoneNumber: string };

/** Codes this module raises; callers map these to HTTP responses. */
export class SignupGuardianError extends Error {
  constructor(
    public code:
      | 'UNKNOWN_NETWORK'
      | 'NOT_GATED'
      | 'NOT_A_MINOR'
      | 'SAME_CONTACT_NOT_ALLOWED'
      | 'GUARDIAN_WARD_LIMIT'
      | 'INVALID_OTP'
      | 'NO_PENDING_SIGNUP',
  ) {
    super(code);
    this.name = 'SignupGuardianError';
  }
}

const PENDING_TTL_SEC = 1800; // 30 min: long enough for an OTP round-trip

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

function hashIdentifier(normalizedValue: string): string {
  return createHash('sha256').update(normalizedValue).digest('hex');
}

const pendingKey = (hash: string) => `signup_guardian:pending:${hash}`;
const otpScope = (hash: string) => `signup_guardian:${hash}`;

interface PendingSignupGuardian {
  network: string;
  domain: string;
  age: number; // stored on user.age at materialize
  guardianName: string; // already encrypted
  guardianContact: string; // already encrypted — the OTP channel
  guardianContactType: GuardianContactType;
  guardianRef: string; // deterministic HMAC of the OTP-channel contact
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
  age: number;
  guardianName: string;
  guardianEmail?: string;
  guardianPhone?: string;
  guardianDeclarationAccepted: true;
  sameContactAcknowledged?: boolean;
}

/**
 * Captures a guardian for a would-be minor signup and sends the OTP. Throws
 * `SignupGuardianError` or, from `issueGuardianOtp`, `GuardianOtpError`. The
 * pending record is written before the OTP is issued, so it remains if the
 * send fails (it expires with its TTL).
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

  if (!isMinor(input.age)) {
    throw new SignupGuardianError('NOT_A_MINOR');
  }

  // Phone is preferred when both contacts are given.
  const channel = resolveOtpChannel({ guardianEmail: input.guardianEmail, guardianPhone: input.guardianPhone });

  // No ward id exists yet, so every ward on this ref counts. Re-checked under
  // a lock at materialization.
  const ref = guardianRef(channel.contact);
  if (await isGuardianWardLimitReached(channel.contact, null)) {
    throw new SignupGuardianError('GUARDIAN_WARD_LIMIT');
  }

  // A ward can't be their own guardian; `sameContactAcknowledged` is not
  // honoured here.
  const ident = normalizeIdentifier(input.identifier);
  const sameContact = guardianContactMatchesWard({
    wardEmail: ident.type === 'email' ? ident.value : null,
    wardPhone: ident.type === 'phone' ? ident.value : null,
    guardianEmail: input.guardianEmail,
    guardianPhone: input.guardianPhone,
  });
  if (sameContact) {
    throw new SignupGuardianError('SAME_CONTACT_NOT_ALLOWED');
  }

  const hash = hashIdentifier(ident.value);

  const pending: PendingSignupGuardian = {
    network: input.network,
    domain: input.domain,
    age: input.age,
    guardianName: encryptGuardianField(input.guardianName),
    guardianContact: encryptGuardianField(channel.contact),
    guardianContactType: channel.contactType,
    guardianRef: ref,
    guardianEmail: input.guardianEmail ? encryptGuardianField(input.guardianEmail) : undefined,
    guardianPhone: input.guardianPhone ? encryptGuardianField(input.guardianPhone) : undefined,
    guardianDeclarationAccepted: true,
    verified: false,
  };
  await writePending(hash, pending);

  // Sent to the plaintext contact; the encrypted copy is for storage only.
  await issueGuardianOtp({
    scope: otpScope(hash),
    contact: channel.contact,
    contactType: channel.contactType,
    scenario: { kind: 'account' },
    variables: { parentName: input.guardianName, domain: input.domain },
  });
}

export interface VerifySignupGuardianInput {
  identifier: SignupIdentifier;
  otp: string;
}

/**
 * Verifies the guardian OTP for a pending signup capture. Only sets the
 * pending record's `verified` flag; nothing is written to Postgres until
 * `materializeSignupGuardian`.
 */
export async function verifySignupGuardian(input: VerifySignupGuardianInput): Promise<void> {
  const ident = normalizeIdentifier(input.identifier);
  const hash = hashIdentifier(ident.value);
  const scope = otpScope(hash);

  const pending = await readPending(hash);
  if (!pending) throw new SignupGuardianError('NO_PENDING_SIGNUP');

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
 * Called by Keycloak provisioning right after a new local user row is created.
 * Finds a verified pending capture by the user's email or phone and, in one
 * transaction, writes the ward's age, the `minor_guardian` row (encrypted
 * blobs copied as-is) and the three U18 consent rows (guardian_declaration
 * source='self', terms and privacy source='guardian'). The pending key is then
 * deleted so it can't be replayed. A no-op when no verified capture exists.
 * Throws when the network's u18 consent versions are not configured.
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
      // The start-time cap check can race across concurrent signups.
      await assertWardLimitWithLock(tx, pending.guardianRef, user.id);
      await setWardAge(user.id, pending.age, tx);
      await writeEncryptedGuardian(
        user.id,
        {
          guardianNameEnc: pending.guardianName,
          guardianContactEnc: pending.guardianContact,
          guardianContactType: pending.guardianContactType,
          guardianEmailEnc: pending.guardianEmail ?? null,
          guardianPhoneEnc: pending.guardianPhone ?? null,
          guardianRef: pending.guardianRef,
        },
        tx,
      );

      await tx.insert(consent_record).values([
        guardianUserConsentRow({
          category: 'guardian_declaration',
          userId: user.id,
          network: pending.network,
          documentVersion: declVersion,
          source: 'self',
          acceptedAt,
        }),
        guardianUserConsentRow({
          category: 'terms',
          userId: user.id,
          network: pending.network,
          documentVersion: termsVersion,
          source: 'guardian',
          acceptedAt,
        }),
        guardianUserConsentRow({
          category: 'privacy',
          userId: user.id,
          network: pending.network,
          documentVersion: privacyVersion,
          source: 'guardian',
          acceptedAt,
        }),
      ]);
    });

    await redis.del(pendingKey(hash));
    return;
  }
}
