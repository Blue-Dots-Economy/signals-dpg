import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BulkSingleError } from '@/lib/bulk';
import type { Action } from '@/lib/action-api';

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/use-consent-config', () => ({ useConsentConfig: () => ({ config: null }) }));
vi.mock('@/theme/theme-provider', () => ({ useNetworkTheme: () => ({ brand: 'standard' }) }));
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }) }));
vi.mock('@/hooks/use-network-config', () => ({
  useNetworkConfig: () => ({
    data: {
      id: 'purple_dot',
      domains: [],
      actions: {
        connect: {
          interactions: [{ from_domain: 'provider', to_domain: 'seeker', reveals_pii_on_status: [] }],
        },
      },
    },
  }),
}));
vi.mock('@/hooks/use-actions', () => ({
  actionKeys: { all: ['actions'] },
  useUpdateActionStatus: () => ({
    isPending: false,
    mutate: (_payload: unknown, opts: { onError: (e: Error) => void }) =>
      opts.onError(new BulkSingleError('GUARDIAN_OTP_REQUIRED', 'Guardian OTP sent', 422, undefined, '******7347')),
  }),
}));

const action = {
  action_id: 'a1',
  action_type: 'connect',
  source_item_network: 'purple_dot',
  source_item_domain: 'provider',
  source_item_type: 'profile_1.0',
  target_item_network: 'purple_dot',
  target_item_domain: 'seeker',
  target_item_type: 'profile_1.0',
} as unknown as Action;

// Mirrors my-actions-page: closing the updater clears the selected action.
function Harness() {
  const [target, setTarget] = React.useState<Action | null>(action);
  return (
    <ActionStatusUpdaterLazy
      action={target}
      open={target !== null}
      onOpenChange={(open) => !open && setTarget(null)}
      suggestedStatus="accepted"
    />
  );
}

let ActionStatusUpdaterLazy: typeof import('../action-status-updater').ActionStatusUpdater;

describe('ActionStatusUpdater guardian OTP', () => {
  it('keeps the OTP dialog open, showing where the code went, when the parent clears the action on close', async () => {
    ({ ActionStatusUpdater: ActionStatusUpdaterLazy } = await import('../action-status-updater'));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

    expect(await screen.findByText(/confirmation via OTP/i)).toBeInTheDocument();
    expect(screen.getByText(/\*{6}7347/)).toBeInTheDocument();
  });
});
