import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';
import { useProfileConsentAccept } from '../use-profile-consent-accept';

vi.mock('@/lib/consent-api', () => ({
  acceptProfileConsent: vi.fn(),
  issueProfileConsentOtp: vi.fn(),
  verifyProfileConsentOtp: vi.fn(),
}));
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signOut: vi.fn() }) }));
vi.mock('@/components/actions/guardian-otp-dialog', () => ({
  GuardianOtpDialog: () => <div data-testid="guardian-otp-dialog" />,
}));
vi.mock('@/components/consent/u18/u18-guardian-flow', () => ({
  U18GuardianFlow: () => <div data-testid="u18-guardian-flow" />,
}));

import { acceptProfileConsent, issueProfileConsentOtp } from '@/lib/consent-api';

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

describe('useProfileConsentAccept', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
