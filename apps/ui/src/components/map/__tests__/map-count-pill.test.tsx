import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MapCountPill } from '../map-count-pill';

describe('MapCountPill — the viewer’s own profiles', () => {
  it('does not count own profiles: all 200 in view are mine → no pill', () => {
    const { container } = render(<MapCountPill total={200} own={200} shown={0} truncated={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts only other listings, so drawn = total reads as "N listings"', () => {
    render(<MapCountPill total={203} own={200} shown={3} truncated={false} />);
    expect(screen.getByText('3 listings')).toBeInTheDocument();
    expect(screen.queryByText(/Showing \d+ of \d+/)).toBeNull();
  });

  it('still says "Showing X of Y" when some other listings are not drawn', () => {
    render(<MapCountPill total={10} own={2} shown={5} truncated={false} />);
    expect(screen.getByText('Showing 5 of 8')).toBeInTheDocument();
  });
});
