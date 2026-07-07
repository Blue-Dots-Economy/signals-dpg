import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnableLocationBanner } from './enable-location-banner';

const COPY = {
  title: 'Showing all practitioners',
  body: 'Enable location to see nearest to you.',
  blockedBody: 'Location is blocked. Allow it in your browser.',
  cta: 'Enable location',
};

describe('EnableLocationBanner', () => {
  it('renders the body + a CTA that calls onEnable when not blocked', async () => {
    const onEnable = vi.fn();
    render(<EnableLocationBanner onEnable={onEnable} {...COPY} />);
    expect(screen.getByText(COPY.title)).toBeInTheDocument();
    expect(screen.getByText(COPY.body)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: COPY.cta }));
    expect(onEnable).toHaveBeenCalledOnce();
  });

  it('shows the blocked copy and drops the CTA when blocked', () => {
    render(<EnableLocationBanner onEnable={vi.fn()} blocked {...COPY} />);
    expect(screen.getByText(COPY.blockedBody)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: COPY.cta })).not.toBeInTheDocument();
  });
});
