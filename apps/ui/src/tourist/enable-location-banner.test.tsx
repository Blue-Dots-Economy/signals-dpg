import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../i18n';
import { EnableLocationBanner } from './enable-location-banner';

describe('EnableLocationBanner', () => {
  it('renders body text and an enable button that calls onEnable', async () => {
    const onEnable = vi.fn();
    render(<EnableLocationBanner onEnable={onEnable} />);
    expect(screen.getByText(/showing all practitioners/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /enable location/i }));
    expect(onEnable).toHaveBeenCalledOnce();
  });
});
