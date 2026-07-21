import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RJSFSchema } from '@rjsf/utils';
import type { Item } from '@/lib/item-api';
import { MatchScoreCard } from './match-score-card';

vi.mock('@/lib/match-score-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/match-score-api')>(
    '@/lib/match-score-api',
  );
  return { ...actual, calculateMatchScore: vi.fn() };
});
import { calculateMatchScore } from '@/lib/match-score-api';

const schema: RJSFSchema = {
  type: 'object',
  properties: { name: { type: 'string', title: 'Name' } },
};

const item = (id: string): Item =>
  ({
    item_id: id,
    item_network: 'blue_dot',
    item_domain: 'provider',
    item_type: 'profile',
    item_instance_url: null,
    item_schema_url: null,
    item_state: { name: 'Dest' },
    item_locations: [],
  }) as unknown as Item;

describe('MatchScoreCard', () => {
  beforeEach(() => {
    vi.mocked(calculateMatchScore).mockReset();
    localStorage.clear();
  });

  it('opens the details modal on the first "See Match Score" click (loading state)', async () => {
    const user = userEvent.setup();
    // Keep the calculation pending so the modal is observed in its loading state.
    vi.mocked(calculateMatchScore).mockReturnValue(new Promise(() => {}));

    render(
      <MatchScoreCard
        schema={schema}
        data={{ name: 'Dest' }}
        localItem={item('mine')}
        networkItem={item('dest')}
      />,
    );

    // No modal before the click.
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: /see match score/i }));

    // The full details modal opens on the FIRST click, in its loading state —
    // the same one-click flow as the map (the list previously required a second
    // click on the score badge to reach the details).
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/match score details/i)).toBeInTheDocument();
    expect(screen.getByText(/calculating match score/i)).toBeInTheDocument();
  });
});
