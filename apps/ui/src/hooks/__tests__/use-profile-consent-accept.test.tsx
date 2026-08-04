import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, render, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';
import {
  useProfileConsentAccept,
  type ProfileConsentAcceptArgs,
  type UseProfileConsentAcceptResult,
} from '../use-profile-consent-accept';

// Capture the mocked dialog/flow props so tests can invoke the success /
// onComplete / onNotMinor callbacks the same way the real components would.
const captured = vi.hoisted(() => ({
  otp: null as null | { onSubmitOtp: (otp: string) => Promise<void> },
  flow: null as null | { onComplete: () => void; onNotMinor: () => void },
}));

vi.mock('@/lib/consent-api', () => ({
  acceptProfileConsent: vi.fn(),
  issueProfileConsentOtp: vi.fn(),
  verifyProfileConsentOtp: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signOut: vi.fn() }) }));
vi.mock('@/components/actions/guardian-otp-dialog', () => ({
  GuardianOtpDialog: (props: { open: boolean; onSubmitOtp: (otp: string) => Promise<void> }) => {
    captured.otp = { onSubmitOtp: props.onSubmitOtp };
    return props.open ? <div data-testid="guardian-otp-dialog" /> : null;
  },
}));
vi.mock('@/components/consent/u18/u18-guardian-flow', () => ({
  U18GuardianFlow: (props: { onComplete: () => void; onNotMinor: () => void }) => {
    captured.flow = { onComplete: props.onComplete, onNotMinor: props.onNotMinor };
    return <div data-testid="u18-guardian-flow" />;
  },
}));

import {
  acceptProfileConsent,
  issueProfileConsentOtp,
  verifyProfileConsentOtp,
} from '@/lib/consent-api';

const network = 'blue_dot';
// Raw network config (as cached by useNetworkConfig): `guardian_consent_required`
// is a plain domain field, no $ref, so the hook can read it straight from cache.
const rawConfig = {
  id: 'blue_dot',
  domains: [
    { id: 'seeker', guardian_consent_required: true },
    { id: 'browse', guardian_consent_required: false },
  ],
} as unknown as DotNetworkSchema;

let client: QueryClient;
function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// Harness that both exposes the hook result and renders its `dialogs` node, so
// the mocked GuardianOtpDialog / U18GuardianFlow actually mount and their props
// get captured. renderHook alone never renders `dialogs`.
let hookResult: UseProfileConsentAcceptResult;
function Harness() {
  hookResult = useProfileConsentAccept();
  return <>{hookResult.dialogs}</>;
}

// A 409 GUARDIAN_REQUIRED axios-shaped rejection (no guardian on file yet →
// hook opens the U18GuardianFlow capture step).
function guardianRequiredError() {
  return Object.assign(new Error('conflict'), {
    isAxiosError: true,
    response: { status: 409, data: { error: 'GUARDIAN_REQUIRED' } },
  });
}

describe('useProfileConsentAccept', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.otp = null;
    captured.flow = null;
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.networkConfig(network), rawConfig);
  });

  it('adult accept records consent and calls onDone', async () => {
    vi.mocked(acceptProfileConsent).mockResolvedValue({ recorded: 1 });
    const onDone = vi.fn();
    const { result } = renderHook(() => useProfileConsentAccept(), { wrapper });

    await act(async () => {
      await result.current.accept({
        network,
        brand: null,
        item: { item_id: 'p1', item_domain: 'seeker', item_type: 'profile_1.0' },
        version: 1,
        isMinor: false,
        onDone,
      });
    });

    expect(acceptProfileConsent).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: 'p1', version: 1 }),
    );
    expect(onDone).toHaveBeenCalled();
    // Cache update: the accepted profile id is added to the profile-consent set.
    expect(client.getQueryData(queryKeys.profileConsent(network))).toEqual(new Set(['p1']));
  });

  it('minor on gated domain issues guardian OTP and does not self-accept', async () => {
    vi.mocked(issueProfileConsentOtp).mockResolvedValue({ otpSent: true });
    const onDone = vi.fn();
    const { result } = renderHook(() => useProfileConsentAccept(), { wrapper });

    await act(async () => {
      await result.current.accept({
        network,
        brand: null,
        item: { item_id: 'p2', item_domain: 'seeker', item_type: 'profile_1.0' },
        version: 1,
        isMinor: true,
        onDone,
      });
    });

    expect(issueProfileConsentOtp).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: 'p2', item_domain: 'seeker' }),
    );
    // Ward self-accept must NEVER promote a minor.
    expect(acceptProfileConsent).not.toHaveBeenCalled();
    // onDone only fires after the guardian OTP is verified, not on issue.
    expect(onDone).not.toHaveBeenCalled();
  });

  it('guardian OTP success promotes the minor: updates caches and calls onDone', async () => {
    vi.mocked(issueProfileConsentOtp).mockResolvedValue({ otpSent: true });
    vi.mocked(verifyProfileConsentOtp).mockResolvedValue({ verified: true, promoted: true });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const onDone = vi.fn();
    const acceptArgs: ProfileConsentAcceptArgs = {
      network,
      brand: null,
      item: { item_id: 'p3', item_domain: 'seeker', item_type: 'profile_1.0' },
      version: 1,
      isMinor: true,
      onDone,
    };

    render(<Harness />, { wrapper });

    // Minor on gated domain → guardian OTP issued → GuardianOtpDialog opens.
    await act(async () => {
      await hookResult.accept(acceptArgs);
    });
    await waitFor(() => expect(captured.otp).not.toBeNull());
    expect(acceptProfileConsent).not.toHaveBeenCalled();
    // A guardian dialog is open → guardianActive is true (consumers gate their
    // own blocking modal on !guardianActive so they don't stack).
    expect(hookResult.guardianActive).toBe(true);

    // Guardian enters a valid code → the dialog's submit handler resolves.
    await act(async () => {
      await captured.otp!.onSubmitOtp('123456');
    });

    expect(verifyProfileConsentOtp).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: 'p3', otp: '123456' }),
    );
    // The promotion cache updates run: profile-consent set gains the id and
    // my-items is invalidated (draft → live promotion leaves the list stale).
    expect(client.getQueryData(queryKeys.profileConsent(network))).toEqual(new Set(['p3']));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.myItems(network) });
    // Guardian consent (not a ward self-accept) is what promotes the minor.
    expect(acceptProfileConsent).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
    // Dialog closed after success → guardianActive returns to false.
    await waitFor(() => expect(hookResult.guardianActive).toBe(false));
  });

  it('U18GuardianFlow onNotMinor does not dead-end: signals status change, no self-accept', async () => {
    vi.mocked(issueProfileConsentOtp).mockRejectedValue(guardianRequiredError());
    const onDone = vi.fn();
    const onGuardianStatusChanged = vi.fn();

    render(<Harness />, { wrapper });

    // Minor, no guardian on file yet → 409 → U18GuardianFlow capture opens.
    await act(async () => {
      await hookResult.accept({
        network,
        brand: null,
        item: { item_id: 'p4', item_domain: 'seeker', item_type: 'profile_1.0' },
        version: 1,
        isMinor: true,
        onDone,
        onGuardianStatusChanged,
      });
    });
    await waitFor(() => expect(captured.flow).not.toBeNull());

    // DOB step reclassifies the ward as an adult.
    act(() => {
      captured.flow!.onNotMinor();
    });

    // Must not dead-end: the consumer is told to re-sync U18 status.
    expect(onGuardianStatusChanged).toHaveBeenCalled();
    // And the ward is NEVER self-accepted for the minor branch.
    expect(acceptProfileConsent).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});
