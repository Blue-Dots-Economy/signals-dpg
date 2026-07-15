import { getNetworkConfigById } from '@/network_configs';
import { getMinorGuardian, getGuardianContactPlaintext } from '@/services/minor_guardian_repo';
import { isMinor, guardianConsentRequired } from '@/services/minor';
import {
  issueGuardianOtp,
  verifyGuardianOtp,
  assertVerifyAttemptAllowed,
  GuardianOtpError,
} from '@/services/guardian_otp';

export type GateInput = {
  wardUserId: string; // source item creator
  network: string;
  sourceDomain: string;
  actionType: string;
  sourceItemId: string;
  targetItemId: string;
  otp?: string; // body.guardian_otp
};

export type GateResult =
  | { status: 'not_required' } // adult or ungated → proceed normally
  | { status: 'challenge_issued' } // OTP sent; caller fails the item GUARDIAN_OTP_REQUIRED
  | { status: 'verified'; scope: string } // OTP ok; caller writes guardian action row + proceeds
  | { status: 'invalid_otp' }
  | { status: 'throttled' }
  | { status: 'rate_limited' }
  | { status: 'no_provider' };

/**
 * U18 guardian-consent gate for actions (Phase 5b). Detects whether the ward
 * is a minor on a guardian-gated domain, issues/verifies an OTP scoped to the
 * specific action, and reports the outcome. It never writes a consent row or
 * resolves a consent version — the caller does that once it sees `verified`.
 */
export async function guardianActionGate(input: GateInput): Promise<GateResult> {
  const cfg = await getNetworkConfigById(input.network);
  if (!guardianConsentRequired(cfg, input.sourceDomain)) {
    return { status: 'not_required' };
  }

  const mg = await getMinorGuardian(input.wardUserId);
  if (!mg || !isMinor(mg.birthYear, mg.birthMonth)) {
    return { status: 'not_required' };
  }

  const scope =
    'guardian_action:' +
    [input.wardUserId, input.actionType, input.sourceItemId, input.targetItemId].join(':');

  if (!input.otp) {
    try {
      const contact = await getGuardianContactPlaintext(input.wardUserId);
      if (!contact) {
        throw new GuardianOtpError('NO_OTP_PROVIDER');
      }
      await issueGuardianOtp({
        scope,
        contact: contact.contact,
        contactType: contact.contactType,
      });
      return { status: 'challenge_issued' };
    } catch (err) {
      if (err instanceof GuardianOtpError) {
        if (err.code === 'RATE_LIMITED') return { status: 'rate_limited' };
        if (err.code === 'NO_OTP_PROVIDER') return { status: 'no_provider' };
      }
      throw err;
    }
  }

  try {
    await assertVerifyAttemptAllowed(scope);
  } catch (err) {
    if (err instanceof GuardianOtpError && err.code === 'VERIFY_THROTTLED') {
      return { status: 'throttled' };
    }
    throw err;
  }

  const ok = await verifyGuardianOtp({ scope, otp: input.otp });
  return ok ? { status: 'verified', scope } : { status: 'invalid_otp' };
}
