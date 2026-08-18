import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActionCard } from '../action-card';
import type { Action } from '@/lib/action-api';

// action-card also calls t() with an interpolation-options object (e.g.
// `t('actions.you_label', { role })`) rather than a string default — only
// treat a *string* second arg as a default, else fall back to the key, so
// an options object never gets rendered as a React child. Defined at module
// scope (not inside the mock factory) so it's a stable reference across
// renders — ProfileCardModal's data-fetch effect depends on `t`, and a fresh
// function identity every render would re-trigger it in an infinite loop.
function mockT(key: string, defaultValue?: string | Record<string, unknown>): string {
  return typeof defaultValue === 'string' ? defaultValue : key;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT }),
}));

function Providers({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderCard(overrides: Partial<Action> = {}) {
  const action: Action = {
    action_id: 'action-1',
    action_type: 'tuition_request',
    action_status: 'created',
    update_count: 0,
    source_item_id: 'source-item-id',
    source_item_network: 'blue_dot',
    source_item_domain: 'student',
    source_item_type: 'profile_1.0',
    source_item_owner: 'user-1',
    target_item_id: 'target-item-id',
    target_item_network: 'blue_dot',
    target_item_domain: 'tutor',
    target_item_type: 'profile_1.0',
    target_item_owner: 'user-2',
    requirements_snapshot: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ownership_roles: ['initiated'],
    ...overrides,
  };

  return render(
    <Providers>
      <ActionCard action={action} ownershipRole="initiated" />
    </Providers>,
  );
}

describe('ActionCard match score + distance', () => {
  it('renders a percentage badge when match_score is set', () => {
    renderCard({ match_score: 8.4 });

    expect(screen.getByText('84%')).toBeInTheDocument();
    expect(screen.queryByText('Not scored yet')).not.toBeInTheDocument();
  });

  it('renders "Not scored yet" and no percentage badge when match_score is null', () => {
    renderCard({ match_score: null });

    expect(screen.getByText('Not scored yet')).toBeInTheDocument();
    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
  });

  it('renders the distance in km to one decimal when distance_m is set', () => {
    renderCard({ distance_m: 3200 });

    expect(screen.getByText('3.2 km')).toBeInTheDocument();
  });

  it('renders no distance text when distance_m is null', () => {
    renderCard({ distance_m: null });

    expect(screen.queryByText(/km$/)).not.toBeInTheDocument();
  });
});
