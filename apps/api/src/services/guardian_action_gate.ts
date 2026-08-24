import { createHash } from 'node:crypto';
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

/** One entry the bulk gate must consider — carries the item's batch index so
 * the caller can map results straight back onto the bulk submit. */
export type BulkGateItem = {
  index: number;
  wardUserId: string;
  network: string;
  sourceDomain: string;
  actionType: string;
  sourceItemId: string;
  targetItemId: string;
};

// Deterministic scope for a ward's gated batch (#393). Hashing the SORTED set of
// (actionType, sourceItem, targetItem) tuples means the guardian's single OTP
// re-matches only when the ward resubmits the SAME batch — change the set and
// it's a new challenge. No server-side batch id to store.
function bulkScope(wardUserId: string, network: string, items: BulkGateItem[]): string {
  const tuples = items
    .map((i) => `${i.actionType}|${i.sourceItemId}|${i.targetItemId}`)
    // Code-point ordering, NOT localeCompare: this ordering is hashed into a
    // Redis scope key that must match byte-for-byte across processes, locales
    // and ICU versions.
    .sort((a, b) => {
      if (a < b) return -1;
      return a > b ? 1 : 0;
    })
    .join(',');
  const hash = createHash('sha256').update(tuples).digest('hex');
  return `guardian_action_bulk:${wardUserId}:${network}:${hash}`;
}

/**
 * Bulk counterpart of {@link guardianActionGate} (#393). Instead of one OTP per
 * action, it issues ONE OTP + ONE email listing every provider org for each
 * ward's gated subset of a bulk submit, and verifies that one OTP for the whole
 * group. Returns a `GateResult` PER ITEM INDEX using the exact same result shape
 * as the single gate, so the bulk handler consumes batch and per-item outcomes
 * identically (same failure mapping, same `verified` → guardian-consent-row).
 *
 * Ungated / adult items are simply absent from the returned map — the caller
 * falls back to the per-item gate for those (a cheap `not_required`). Fail-closed
 * throughout: a null age on a gated domain, or a missing guardian contact, never
 * proceeds. `guardianConsentRequired` / age check remain the single source of
 * truth — this only changes how the OTP is scoped, not who is gated.
 */
export async function guardianBulkActionGate(args: {
  items: BulkGateItem[];
  stage?: 'initiate' | 'accept';
  otp?: string;
}): Promise<Map<number, GateResult>> {
  const results = new Map<number, GateResult>();

  // Resolve gated-ness once per (network) config + once per ward age.
  const configCache = new Map<string, Awaited<ReturnType<typeof getNetworkConfigById>>>();
  const ageCache = new Map<string, number | null>();
  const getCfg = async (network: string) => {
    const hit = configCache.get(network);
    if (hit) return hit;
    const cfg = await getNetworkConfigById(network);
    configCache.set(network, cfg);
    return cfg;
  };
  const getAge = async (ward: string) => {
    if (ageCache.has(ward)) return ageCache.get(ward) ?? null;
    const age = await getWardAge(ward);
    ageCache.set(ward, age);
    return age;
  };

  // Bucket the gated items by ward+network (the scope + provider-name lookups
  // are network-scoped, so a ward acting across networks gets one OTP each).
  const groups = new Map<string, BulkGateItem[]>();
  for (const item of args.items) {
    const cfg = await getCfg(item.network);
    if (!guardianConsentRequired(cfg, item.sourceDomain)) continue;
    const age = await getAge(item.wardUserId);
    if (age === null || !isMinor(age)) continue;
    const key = `${item.wardUserId}::${item.network}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  for (const bucket of groups.values()) {
    const { wardUserId, network } = bucket[0];
    const scope = bulkScope(wardUserId, network, bucket);
    const assign = (r: GateResult) => {
      for (const item of bucket) results.set(item.index, r);
    };

    if (!args.otp) {
      try {
        const contact = await getGuardianContactPlaintext(wardUserId);
        if (!contact) throw new GuardianOtpError('NO_OTP_PROVIDER');
        const parentName = await getGuardianNamePlaintext(wardUserId);
        // Provider org names in submit order, de-duplicated, nulls dropped.
        const names: string[] = [];
        const seen = new Set<string>();
        for (const item of bucket) {
          const name = await resolveProviderServiceName(item.targetItemId, network);
          if (name && !seen.has(name)) {
            seen.add(name);
            names.push(name);
          }
        }
        await issueGuardianOtp({
          scope,
          contact: contact.contact,
          contactType: contact.contactType,
          scenario: {
            kind: 'action_bulk',
            actionType: bucket[0].actionType,
            stage: args.stage ?? 'initiate',
            providerOrgNames: names,
            // Bluedots networks use "jobs" copy; everything else "opportunities"
            // (#393). No network.json flag exists for this yet.
            jobs: network === 'blue_dot',
          },
          variables: parentName ? { parentName } : {},
        });
        assign({ status: 'challenge_issued' });
      } catch (err) {
        if (err instanceof GuardianOtpError) {
          if (err.code === 'RATE_LIMITED') { assign({ status: 'rate_limited' }); continue; }
          if (err.code === 'NO_OTP_PROVIDER') { assign({ status: 'no_provider' }); continue; }
        }
        throw err;
      }
      continue;
    }

    try {
      await assertVerifyAttemptAllowed(scope);
    } catch (err) {
      if (err instanceof GuardianOtpError && err.code === 'VERIFY_THROTTLED') {
        assign({ status: 'throttled' });
        continue;
      }
      throw err;
    }

    // Verify + CONSUME once for the whole group — a single correct OTP unlocks
    // every gated item in the batch.
    const ok = await verifyGuardianOtp({ scope, otp: args.otp });
    assign(ok ? { status: 'verified' } : { status: 'invalid_otp' });
  }

  return results;
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
