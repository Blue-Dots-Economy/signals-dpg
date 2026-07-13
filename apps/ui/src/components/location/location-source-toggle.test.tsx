import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocationSourceToggle } from './location-source-toggle';

describe('LocationSourceToggle', () => {
  it('renders both source options', () => {
    render(<LocationSourceToggle value="profile" onChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: /my profile/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /current location/i })).toBeInTheDocument();
  });

  it('calls onChange with the picked source', async () => {
    const onChange = vi.fn();
    render(<LocationSourceToggle value="profile" onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: /current location/i }));
    expect(onChange).toHaveBeenCalledWith('browser');
  });
});
