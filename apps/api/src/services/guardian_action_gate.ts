import { BulkItemFailure } from '@/utils/bulk_runner';
import { getNetworkConfigById } from '@/network_configs';
import {
  getWardAge,
  getGuardianContactPlaintext,
  getGuardianNamePlaintext,
} from '@/services/minor_guardian_repo';
import { isMinor, guardianConsentRequired } from '@/services/minor';
import { resolveProviderServiceName } from '@/notifications/resolve_owner';
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
  stage?: 'initiate' | 'accept'; // perform → initiate (default), accept-status → accept
  channel: 'self' | 'external'; // Boolean(request.acting_org): UI self-session vs on-behalf (#395)
  otp?: string; // body.guardian_otp
};

export type GateResult =
  | { status: 'not_required' } // adult or ungated → proceed normally
  | { status: 'challenge_issued' } // OTP sent; caller fails the item GUARDIAN_OTP_REQUIRED
  | { status: 'verified' } // OTP ok; caller writes guardian action row + proceeds
  | { status: 'invalid_otp' }
  | { status: 'throttled' }
  | { status: 'rate_limited' }
  | { status: 'no_provider' }
  | { status: 'external_minor_blocked'; reason: 'minor' | 'age_unknown' }; // U18 on external channel (#395)

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

  const age = await getWardAge(input.wardUserId);

  // External / on-behalf channel (#395): there is no guardian-OTP path over
  // voice/aggregator for now, so a minor — or, fail-closed, an age-unknown
  // ward — is blocked outright and must complete the action in the app (the
  // `self` path below). A confirmed adult proceeds unchanged. The `reason`
  // (`minor` | `age_unknown`) rides on the result for support triage; the
  // caller's client-facing message never leaks it (see guardianGateFailure).
  if (input.channel === 'external') {
    if (age !== null && !isMinor(age)) {
      return { status: 'not_required' };
    }
    return { status: 'external_minor_blocked', reason: age === null ? 'age_unknown' : 'minor' };
  }

  // channel === 'self' (UI): existing behavior verbatim.
  if (age === null || !isMinor(age)) {
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
      // Parent-facing template vars (#294) — best-effort; the OTP is dispatched
      // regardless if either lookup returns null (template renders without them).
      const [parentName, providerOrgName] = await Promise.all([
        getGuardianNamePlaintext(input.wardUserId),
        resolveProviderServiceName(input.targetItemId, input.network),
      ]);
      await issueGuardianOtp({
        scope,
        contact: contact.contact,
        contactType: contact.contactType,
        // action_type comes straight from network.json (the interaction) — the
        // template id derives from it, no hardcoded connect/apply.
        scenario: { kind: 'action', actionType: input.actionType, stage: input.stage ?? 'initiate' },
        variables: {
          ...(parentName ? { parentName } : {}),
          ...(providerOrgName ? { providerOrgName } : {}),
        },
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
  return ok ? { status: 'verified' } : { status: 'invalid_otp' };
}

/**
 * Map a non-proceeding gate result to the per-item BulkItemFailure the action
 * handlers throw. Returns null for `not_required` / `verified` (the caller
 * proceeds). Shared by perform_action + update_action_status so the error
 * codes/messages can't drift between the two.
 */
export function guardianGateFailure(gate: GateResult): BulkItemFailure | null {
  switch (gate.status) {
    case 'challenge_issued':
      return new BulkItemFailure(
        'GUARDIAN_OTP_REQUIRED',
        'Guardian OTP sent; resubmit with guardian_otp to confirm this action.',
      );
    case 'invalid_otp':
      return new BulkItemFailure('GUARDIAN_OTP_INVALID', 'Guardian OTP is invalid or expired.');
    case 'throttled':
      return new BulkItemFailure('GUARDIAN_OTP_THROTTLED', 'Too many guardian OTP attempts; try again shortly.');
    case 'rate_limited':
      return new BulkItemFailure('GUARDIAN_OTP_RATE_LIMITED', 'Too many guardian OTP requests; try again shortly.');
    case 'no_provider':
      return new BulkItemFailure(
        'OTP_PROVIDER_UNAVAILABLE',
        'No verified contact channel is available to send the guardian OTP.',
      );
    case 'external_minor_blocked':
      // reason (`minor` | `age_unknown`) is carried on the gate result for
      // support triage; the client message deliberately does not leak it.
      return new BulkItemFailure(
        'MINOR_ACTION_CHANNEL_BLOCKED',
        "This participant is a minor; actions for minors must be completed in the app and can't be performed via this channel.",
      );
    default:
      return null; // not_required | verified → proceed
  }
}
