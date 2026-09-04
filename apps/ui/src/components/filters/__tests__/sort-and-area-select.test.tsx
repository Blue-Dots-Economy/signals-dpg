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

  it('HIDES every radius option when no centre resolves', async () => {
    // Hide rather than disable, the same call made for domains (spec D7a):
    // a permanently dead row reads as a broken control, and there is nothing
    // the user can do about a missing location from inside this menu.
    render(<AreaSelect value={{ mode: 'anywhere' }} defaultCenter={null} onChange={vi.fn()} />);
    await open();

    expect(screen.queryByRole('option', { name: /25 km/i })).toBeNull();
    expect(screen.queryByText(/custom distance/i)).toBeNull();
    // Anywhere is always reachable, so the control is never empty.
    expect(screen.getByRole('option', { name: /anywhere/i })).toBeInTheDocument();
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

describe('AreaSelect — viewport mode', () => {
  const open = async () =>
    userEvent.click(screen.getByRole('button', { name: /area/i }));
  const BOUNDS = { minLat: 12.8, minLng: 77.4, maxLat: 13.1, maxLng: 77.8 };

  it('offers the map area and emits the exact bounds', async () => {
    // Restores the mode spec D6 dropped. It is exact now, so there is no
    // "approximate" caveat: signals-search has a bbox op, and a circumscribed
    // circle would have included items off the edges of the map.
    const onChange = vi.fn();
    render(
      <AreaSelect
        value={{ mode: 'anywhere' }}
        defaultCenter={{ lat: 1, lng: 2 }}
        viewportBounds={BOUNDS}
        onChange={onChange}
      />,
    );
    await open();
    await userEvent.click(screen.getByRole('option', { name: /area shown on the map/i }));

    expect(onChange).toHaveBeenCalledWith({ mode: 'viewport', bounds: BOUNDS });
  });

  it('HIDES the map-area option before the map has reported bounds', async () => {
    // "The area shown on the map" is meaningless when no map has been shown,
    // and the Area control lives in the LIST view.
    render(
      <AreaSelect
        value={{ mode: 'anywhere' }}
        defaultCenter={{ lat: 1, lng: 2 }}
        viewportBounds={null}
        onChange={vi.fn()}
      />,
    );
    await open();

    expect(screen.queryByRole('option', { name: /area shown on the map/i })).toBeNull();
  });

  it('labels the trigger with the map area when that mode is active', () => {
    render(
      <AreaSelect
        value={{ mode: 'viewport', bounds: BOUNDS }}
        defaultCenter={{ lat: 1, lng: 2 }}
        viewportBounds={BOUNDS}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /area/i })).toHaveTextContent(
      /area shown on the map/i,
    );
  });
});

describe('AreaSelect — custom distance', () => {
  const open = async () =>
    userEvent.click(screen.getByRole('button', { name: /area/i }));
  const openCustom = async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: /custom distance/i }));
  };
  const field = () => screen.getByRole('textbox', { name: /distance in kilometres/i });

  it('applies a typed whole number on the tick', async () => {
    const onChange = vi.fn();
    render(
      <AreaSelect
        value={{ mode: 'anywhere' }}
        defaultCenter={{ lat: 1, lng: 2 }}
        onChange={onChange}
      />,
    );
    await openCustom();
    await userEvent.type(field(), '7');
    // Nothing applied until commit — this is what keeps a per-keystroke
    // request (and a distinct cache entry per intermediate number) from
    // happening at all.
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /apply this distance/i }));
    expect(onChange).toHaveBeenCalledWith({
      mode: 'radius',
      center: { lat: 1, lng: 2 },
      meters: 7000,
    });
  });

  it('applies on Enter as well as the tick', async () => {
    const onChange = vi.fn();
    render(
      <AreaSelect
        value={{ mode: 'anywhere' }}
        defaultCenter={{ lat: 1, lng: 2 }}
        onChange={onChange}
      />,
    );
    await openCustom();
    await userEvent.type(field(), '12{Enter}');

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'radius', meters: 12000 }),
    );
  });

  it('BLOCKS decimals rather than rounding them', async () => {
    // Rounding 12.5 to 13 would mean the field and the request disagree
    // mid-edit; refusing the character keeps them identical at all times.
    render(
      <AreaSelect
        value={{ mode: 'anywhere' }}
        defaultCenter={{ lat: 1, lng: 2 }}
        onChange={vi.fn()}
      />,
    );
    await openCustom();
    await userEvent.type(field(), '12.5');

    expect(field()).toHaveValue('125');
  });

  it('refuses a value outside 1–500 and says so', async () => {
    const onChange = vi.fn();
    render(
      <AreaSelect
        value={{ mode: 'anywhere' }}
        defaultCenter={{ lat: 1, lng: 2 }}
        onChange={onChange}
      />,
    );
    await openCustom();
    await userEvent.type(field(), '999');

    expect(screen.getByRole('alert')).toHaveTextContent(/between 1 and 500/i);
    expect(screen.getByRole('button', { name: /apply this distance/i })).toBeDisabled();
    await userEvent.type(field(), '{Enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refuses zero, which is not a searchable radius', async () => {
    render(
      <AreaSelect
        value={{ mode: 'anywhere' }}
        defaultCenter={{ lat: 1, lng: 2 }}
        onChange={vi.fn()}
      />,
    );
    await openCustom();
    await userEvent.type(field(), '0');

    expect(screen.getByRole('button', { name: /apply this distance/i })).toBeDisabled();
  });

  it('clears the field from the in-field cross, without applying anything', async () => {
    const onChange = vi.fn();
    render(
      <AreaSelect
        value={{ mode: 'anywhere' }}
        defaultCenter={{ lat: 1, lng: 2 }}
        onChange={onChange}
      />,
    );
    await openCustom();
    await userEvent.type(field(), '42');
    await userEvent.click(screen.getByRole('button', { name: /clear the distance/i }));

    expect(field()).toHaveValue('');
    // Clear empties the input; it does not reset the applied area.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('takes its presets from the caller, not a hardcoded ladder', async () => {
    // The 5/10/25 default was never part of #644, which specifies only
    // `{ mode: 'radius', center, meters }`.
    render(
      <AreaSelect
        value={{ mode: 'anywhere' }}
        defaultCenter={{ lat: 1, lng: 2 }}
        presetsKm={[3, 8]}
        onChange={vi.fn()}
      />,
    );
    await open();

    expect(screen.getByRole('option', { name: /3 km/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /8 km/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /25 km/i })).toBeNull();
  });
});
