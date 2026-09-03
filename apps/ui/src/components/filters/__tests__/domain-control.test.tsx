import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DomainControl } from '../domain-control';

/**
 * The one domain control (#645, spec D10/D11). Replaces the sidebar Browse tab
 * AND the facet panel's own domain multi-select — domain IS a filter, so it
 * lives with the other filters.
 *
 * Single-select on the list (one `/discover` call takes exactly one
 * `item_domain`); multi-select on the map (one `/markers` call per domain).
 */

const opts = [
  { id: 'provider', label: 'Provider', available: true },
  { id: 'trainer', label: 'Trainer', available: true },
  {
    id: 'seeker',
    label: 'Seeker',
    available: false,
    unavailableReason: "You can't connect with other seekers",
  },
];

describe('DomainControl — single mode (list)', () => {
  it('replaces the selection rather than adding to it', async () => {
    const onChange = vi.fn();
    render(
      <DomainControl options={opts} mode="single" selected={['provider']} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Trainer/ }));
    expect(onChange).toHaveBeenCalledWith(['trainer']);
  });

  it('marks the selected option pressed and the others not', () => {
    render(<DomainControl options={opts} mode="single" selected={['provider']} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Provider/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /Trainer/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('never deselects the last domain — the list always needs exactly one', async () => {
    const onChange = vi.fn();
    render(
      <DomainControl options={opts} mode="single" selected={['provider']} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Provider/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DomainControl — multi mode (map)', () => {
  it('adds to the selection', async () => {
    const onChange = vi.fn();
    render(
      <DomainControl options={opts} mode="multi" selected={['provider']} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Trainer/ }));
    expect(onChange).toHaveBeenCalledWith(['provider', 'trainer']);
  });

  it('removes from the selection', async () => {
    const onChange = vi.fn();
    render(
      <DomainControl
        options={opts}
        mode="multi"
        selected={['provider', 'trainer']}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Trainer/ }));
    expect(onChange).toHaveBeenCalledWith(['provider']);
  });

  it('never empties the selection — a blank map with no way back is worse', async () => {
    const onChange = vi.fn();
    render(
      <DomainControl options={opts} mode="multi" selected={['provider']} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Provider/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DomainControl — unavailable domains (spec D7 / #645)', () => {
  it('LISTS an unavailable domain with its reason instead of hiding it', () => {
    // computeVisibleDomains silently removed entire domains for signed-in
    // viewers, which users experienced as those domains not existing. The
    // interaction matrix is unchanged — only made visible.
    render(<DomainControl options={opts} mode="single" selected={['provider']} onChange={vi.fn()} />);
    const seeker = screen.getByRole('button', { name: /Seeker/ });
    expect(seeker).toBeDisabled();
    expect(seeker).toHaveAccessibleDescription(/can't connect with other seekers/i);
  });

  it('cannot be selected', async () => {
    const onChange = vi.fn();
    render(
      <DomainControl options={opts} mode="single" selected={['provider']} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Seeker/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('cannot be selected in multi mode either', async () => {
    const onChange = vi.fn();
    render(
      <DomainControl options={opts} mode="multi" selected={['provider']} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Seeker/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DomainControl — accessibility', () => {
  it('is a labelled group', () => {
    render(<DomainControl options={opts} mode="single" selected={['provider']} onChange={vi.fn()} />);
    expect(screen.getByRole('group', { name: /domain/i })).toBeInTheDocument();
  });

  it('keeps a coarse-pointer touch target on every option', () => {
    render(<DomainControl options={opts} mode="single" selected={['provider']} onChange={vi.fn()} />);
    for (const name of [/Provider/, /Trainer/, /Seeker/]) {
      expect(screen.getByRole('button', { name })).toHaveClass('pointer-coarse:min-h-11');
    }
  });
});
