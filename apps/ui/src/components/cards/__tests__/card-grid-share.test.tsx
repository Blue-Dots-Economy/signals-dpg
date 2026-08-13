import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CardGrid } from '../card-grid';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }) }));

vi.mock('@/components/cards/domain-card', () => ({
  DomainCard: (props: { shareItem?: { item_id: string } | null }) => (
    <div data-testid="dc" data-share={props.shareItem?.item_id ?? ''} />
  ),
}));

vi.mock('@/components/match-score', () => ({
  MatchScoreCard: (props: { networkItem?: { item_id: string } | null }) => (
    <div data-testid="msc" data-share={props.networkItem?.item_id ?? ''} />
  ),
}));

const shouldRenderMatchScoreCard = vi.fn();
vi.mock('@/lib/match-score-config', () => ({
  shouldRenderMatchScoreCard: (...args: unknown[]) => shouldRenderMatchScoreCard(...args),
}));

const fullItem = {
  item_id: 'item-1',
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  item_instance_url: null,
  item_schema_url: null,
  item_state: { name: 'Asha' },
  item_locations: [],
  created_at: '',
  updated_at: '',
  lifecycle_status: 'live' as const,
};

const items = [{ id: 'item-1', data: { name: 'Asha' } }];

describe('CardGrid share wiring', () => {
  it('threads shareItem into the plain DomainCard branch (single-domain listing)', () => {
    shouldRenderMatchScoreCard.mockReturnValue(false);

    render(
      <CardGrid
        schema={{ type: 'object', properties: {} }}
        items={items}
        fullItems={[fullItem]}
      />,
    );

    const dc = screen.getByTestId('dc');
    expect(dc).toHaveAttribute('data-share', 'item-1');
    expect(screen.queryByTestId('msc')).not.toBeInTheDocument();
  });

  it('threads networkItem into the MatchScoreCard branch (which itself forwards it on as shareItem into DomainCard, per match-score-card.tsx)', () => {
    shouldRenderMatchScoreCard.mockReturnValue(true);

    render(
      <CardGrid
        schema={{ type: 'object', properties: {} }}
        items={items}
        fullItems={[fullItem]}
      />,
    );

    const msc = screen.getByTestId('msc');
    expect(msc).toHaveAttribute('data-share', 'item-1');
    expect(screen.queryByTestId('dc')).not.toBeInTheDocument();
  });
});
