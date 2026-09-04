import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SortSelect } from '../sort-select';
import { AreaSelect } from '../area-select';

/**
 * #644 §3.1/§3.2. Two controls that had no home before: the list's order and
 * its (opt-in) area filter.
 */

describe('SortSelect', () => {
  const open = async () => userEvent.click(screen.getByRole('button', { name: /sort/i }));

  it('offers all three orders', async () => {
    render(
      <SortSelect value="relevance" nearestAvailable basis="profile" onChange={vi.fn()} />,
    );
    await open();
    expect(screen.getByRole('option', { name: /your profile/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /newest/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /nearest/i })).toBeInTheDocument();
  });

  it('marks nearest unavailable WITH a reason when no location resolves', async () => {
    render(
      <SortSelect
        value="relevance"
        nearestAvailable={false}
        basis="profile"
        onChange={vi.fn()}
      />,
    );
    await open();
    const nearest = screen.getByRole('option', { name: /nearest/i });
    expect(nearest).toHaveAttribute('aria-disabled', 'true');
    expect(nearest).toHaveAccessibleDescription(/location/i);
  });

  it('does not emit a change for an unavailable option', async () => {
    const onChange = vi.fn();
    render(
      <SortSelect value="relevance" nearestAvailable={false} basis="profile" onChange={onChange} />,
    );
    await open();
    await userEvent.click(screen.getByRole('option', { name: /nearest/i }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('emits the picked order', async () => {
    const onChange = vi.fn();
    render(<SortSelect value="relevance" nearestAvailable basis="profile" onChange={onChange} />);
    await open();
    await userEvent.click(screen.getByRole('option', { name: /newest/i }));
    expect(onChange).toHaveBeenCalledWith('newest');
  });

  it('labels the relevance basis as PROFILE when an anchor is present', () => {
    render(
      <SortSelect
        value="relevance"
        applied="relevance"
        nearestAvailable
        basis="profile"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /sort/i })).toHaveTextContent(/your profile/i);
  });

  it('labels the relevance basis as SEARCH when there is no anchor', () => {
    // After the #148 fix the score is still profile-based whenever an anchor
    // exists (spec D14), so "your search" is reserved for the genuinely
    // text-ranked case.
    render(
      <SortSelect
        value="relevance"
        applied="relevance"
        nearestAvailable
        basis="search"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /sort/i })).toHaveTextContent(/your search/i);
  });

  it('shows what the SERVER applied, not what was requested', () => {
    // relevance requested, but with no anchor and no text the BFF returns
    // newest. Showing "Relevance" would claim an order we did not get.
    render(
      <SortSelect
        value="relevance"
        applied="newest"
        nearestAvailable
        basis={null}
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole('button', { name: /sort/i });
    expect(trigger).toHaveTextContent(/newest/i);
    expect(trigger).not.toHaveTextContent(/your profile/i);
  });
});

describe('AreaSelect', () => {
  const open = async () => userEvent.click(screen.getByRole('button', { name: /area/i }));

  it('defaults to Anywhere, making the unbounded list legible', () => {
    render(<AreaSelect value={{ mode: 'anywhere' }} defaultCenter={null} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /area/i })).toHaveTextContent(/anywhere/i);
  });

  it('emits a radius area seeded with the viewer location as its centre', async () => {
    const onChange = vi.fn();
    render(
      <AreaSelect
        value={{ mode: 'anywhere' }}
        defaultCenter={{ lat: 12.97, lng: 77.59 }}
        onChange={onChange}
      />,
    );
    await open();
    await userEvent.click(screen.getByRole('option', { name: /25 km/i }));
    expect(onChange).toHaveBeenCalledWith({
      mode: 'radius',
      center: { lat: 12.97, lng: 77.59 },
      meters: 25000,
    });
  });

  it('marks the radius options unavailable when no centre resolves', async () => {
    render(<AreaSelect value={{ mode: 'anywhere' }} defaultCenter={null} onChange={vi.fn()} />);
    await open();
    expect(screen.getByRole('option', { name: /25 km/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('emits nothing for a radius with no centre', async () => {
    const onChange = vi.fn();
    render(<AreaSelect value={{ mode: 'anywhere' }} defaultCenter={null} onChange={onChange} />);
    await open();
    await userEvent.click(screen.getByRole('option', { name: /25 km/i }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('can return to Anywhere', async () => {
    const onChange = vi.fn();
    render(
      <AreaSelect
        value={{ mode: 'radius', center: { lat: 1, lng: 2 }, meters: 25000 }}
        defaultCenter={{ lat: 1, lng: 2 }}
        onChange={onChange}
      />,
    );
    await open();
    await userEvent.click(screen.getByRole('option', { name: /anywhere/i }));
    expect(onChange).toHaveBeenCalledWith({ mode: 'anywhere' });
  });

  it('shows the active radius on the trigger', () => {
    render(
      <AreaSelect
        value={{ mode: 'radius', center: { lat: 1, lng: 2 }, meters: 10000 }}
        defaultCenter={{ lat: 1, lng: 2 }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /area/i })).toHaveTextContent(/10 km/i);
  });
});

describe('SortSelect — relevance availability', () => {
  it('OMITS relevance when the server cannot rank by it (Q2)', async () => {
    // Signed out with no typed text, or signals-search down and the BFF
    // degraded to its native path: the request comes back
    // `sort_applied: 'newest'`. Offering the option produced a menu that
    // ticked "Relevance to your profile" while the trigger read "Newest".
    render(
      <SortSelect
        value="newest"
        applied="newest"
        nearestAvailable
        basis={null}
        relevanceAvailable={false}
        onChange={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /sort/i }));

    expect(screen.queryByRole('option', { name: /relevance/i })).toBeNull();
    expect(screen.getByRole('option', { name: /newest/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /nearest/i })).toBeInTheDocument();
  });

  it('offers relevance when it is available', async () => {
    render(
      <SortSelect
        value="relevance"
        applied="relevance"
        nearestAvailable
        basis="profile"
        relevanceAvailable
        onChange={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /sort/i }));

    expect(screen.getByRole('option', { name: /relevance/i })).toBeInTheDocument();
  });

  it('names what Newest sorts on, so a card age is unambiguous (Q3)', async () => {
    render(
      <SortSelect
        value="newest"
        applied="newest"
        nearestAvailable
        basis={null}
        onChange={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /sort/i }));

    expect(screen.getByRole('option', { name: /newest/i })).toHaveTextContent(/when it was posted/i);
  });
});
