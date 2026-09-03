import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppliedFilterChips } from '../applied-filter-chips';
import type { AppliedChip } from '../applied-filter-chips';

/**
 * The applied-filter read-out (#645 §4.1). One removable chip per active
 * constraint plus a clear-all, so "what is currently filtering this list?"
 * has a single answer on screen.
 *
 * Chips are the READ-OUT; the facet panel and the app-bar search box remain
 * the EDITORS (spec §7.1). This component formats nothing and owns no filter
 * state — it renders what it is given and reports removals back.
 */

const chips: AppliedChip[] = [
  { kind: 'search', id: 'q', label: '"solar installer"', removable: true },
  { kind: 'facet', id: 'facet:sector', label: 'Sector: Energy', removable: true },
  { kind: 'area', id: 'area', label: 'Within 25 km', removable: true },
];

describe('AppliedFilterChips', () => {
  it('renders exactly one chip per active constraint', () => {
    render(<AppliedFilterChips chips={chips} onRemove={vi.fn()} onClearAll={vi.fn()} />);
    expect(screen.getAllByTestId('applied-chip')).toHaveLength(3);
  });

  it('renders nothing at all when no constraint is applied', () => {
    // The toolbar shows its own "no filters applied" text in that state, so a
    // stray empty group here would double up.
    const { container } = render(
      <AppliedFilterChips chips={[]} onRemove={vi.fn()} onClearAll={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('passes the removed chip back to the caller', async () => {
    const onRemove = vi.fn();
    render(<AppliedFilterChips chips={chips} onRemove={onRemove} onClearAll={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /remove Sector: Energy/i }));
    expect(onRemove).toHaveBeenCalledWith(chips[1]);
  });

  it('clears everything through one action', async () => {
    const onClearAll = vi.fn();
    render(<AppliedFilterChips chips={chips} onRemove={vi.fn()} onClearAll={onClearAll} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all/i }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it('omits the remove affordance on a non-removable chip', () => {
    // The domain chip is not removable: the list always needs exactly one.
    render(
      <AppliedFilterChips
        chips={[{ kind: 'domain', id: 'domain', label: 'Provider', removable: false }]}
        onRemove={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /remove Provider/i })).toBeNull();
    expect(screen.getByTestId('applied-chip')).toHaveTextContent('Provider');
  });

  it('marks the search chip as edited elsewhere', () => {
    // Its editor is the app-bar box (spec D24/D25), so it is styled
    // distinctly — remove here, edit above.
    render(<AppliedFilterChips chips={chips} onRemove={vi.fn()} onClearAll={vi.fn()} />);
    const searchChip = screen.getAllByTestId('applied-chip')[0];
    expect(searchChip.className).toMatch(/border-dashed/);
  });
});

describe('AppliedFilterChips — accessibility (spec §4.6)', () => {
  it('is a labelled group', () => {
    render(<AppliedFilterChips chips={chips} onRemove={vi.fn()} onClearAll={vi.fn()} />);
    expect(screen.getByRole('group', { name: /applied filters/i })).toBeInTheDocument();
  });

  it('returns focus to the group after a removal', async () => {
    // The button the user activated unmounts with its chip, so without this
    // focus falls to <body> and keyboard users lose their place entirely.
    const { rerender } = render(
      <AppliedFilterChips chips={chips} onRemove={vi.fn()} onClearAll={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /remove Sector: Energy/i }));
    rerender(
      <AppliedFilterChips
        chips={[chips[0], chips[2]]}
        onRemove={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );
    expect(screen.getByRole('group', { name: /applied filters/i })).toHaveFocus();
  });

  it('does not steal focus on an unrelated re-render', async () => {
    const { rerender } = render(
      <AppliedFilterChips chips={chips} onRemove={vi.fn()} onClearAll={vi.fn()} />,
    );
    const clearAll = screen.getByRole('button', { name: /clear all/i });
    clearAll.focus();
    rerender(
      <AppliedFilterChips chips={[...chips]} onRemove={vi.fn()} onClearAll={vi.fn()} />,
    );
    expect(clearAll).toHaveFocus();
  });

  it('keeps a coarse-pointer touch target on every interactive element', () => {
    render(<AppliedFilterChips chips={chips} onRemove={vi.fn()} onClearAll={vi.fn()} />);
    for (const chip of screen.getAllByTestId('applied-chip')) {
      expect(chip.className).toMatch(/pointer-coarse:min-h-11/);
    }
    expect(screen.getByRole('button', { name: /clear all/i }).className).toMatch(
      /pointer-coarse:min-h-11/,
    );
  });
});
