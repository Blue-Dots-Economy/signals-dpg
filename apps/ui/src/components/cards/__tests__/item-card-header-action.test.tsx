import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ItemCard } from '../item-card';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }) }));

describe('ItemCard headerAction slot', () => {
  it('renders the headerAction node in the header', () => {
    render(
      <ItemCard
        schema={{ type: 'object', properties: {} }}
        data={{ name: 'Asha' }}
        headerAction={<button data-testid="share-slot">share</button>}
      />,
    );
    expect(screen.getByTestId('share-slot')).toBeInTheDocument();
  });
});
