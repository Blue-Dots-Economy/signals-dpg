import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MapCountPill } from './map-count-pill';

// #203 map-serverside-search Task 6: the over-dense "N+ in this area — zoom
// in" indicator must show for BOTH anonymous and signed-in visitors whenever
// the viewport's true total exceeds the active zoom-band cap, and must not
// regress the pre-existing signed-out-only plain count pill for the
// non-truncated case.
describe('MapCountPill', () => {
  it('renders the over-dense "N+ zoom in" message with the true total when truncated, for a signed-out visitor', () => {
    render(<MapCountPill total={1500} shown={1000} truncated={true} signedIn={false} />);
    expect(screen.getByText('1500+ in this area — zoom in')).toBeInTheDocument();
  });

  it('renders the over-dense "N+ zoom in" message with the true total when truncated, for a SIGNED-IN visitor too', () => {
    render(<MapCountPill total={1500} shown={1000} truncated={true} signedIn={true} />);
    expect(screen.getByText('1500+ in this area — zoom in')).toBeInTheDocument();
  });

  it('hides entirely when not truncated and signed in (no regression: signed-in visitors get the header count, not this pill)', () => {
    render(<MapCountPill total={42} shown={42} truncated={false} signedIn={true} />);
    expect(screen.queryByText(/in this area/)).not.toBeInTheDocument();
    expect(screen.queryByText(/listing/)).not.toBeInTheDocument();
  });

  it('shows the plain "Showing X of Y" count pill for a signed-out visitor when not truncated and partially shown', () => {
    render(<MapCountPill total={42} shown={10} truncated={false} signedIn={false} />);
    expect(screen.getByText('Showing 10 of 42')).toBeInTheDocument();
  });

  it('shows the plain listings count pill for a signed-out visitor when not truncated and fully shown', () => {
    render(<MapCountPill total={5} shown={5} truncated={false} signedIn={false} />);
    expect(screen.getByText('5 listings')).toBeInTheDocument();
  });

  it('renders nothing when there are no results at all', () => {
    render(<MapCountPill total={0} shown={0} truncated={false} signedIn={false} />);
    expect(screen.queryByText(/in this area/)).not.toBeInTheDocument();
    expect(screen.queryByText(/listing/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });
});
