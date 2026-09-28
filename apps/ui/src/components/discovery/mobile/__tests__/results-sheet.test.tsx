import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResultsSheet, resolveSnap, snapOffsets, type SheetSnap } from '../results-sheet';

function renderSheet(snap: SheetSnap, onSnapChange = vi.fn()) {
  render(
    <ResultsSheet snap={snap} onSnapChange={onSnapChange} header={<button type="button">header control</button>}>
      <p>list body</p>
    </ResultsSheet>,
  );
  return onSnapChange;
}

describe('snapOffsets', () => {
  it('places full at the top, half mid-way and peek so only the header shows', () => {
    expect(snapOffsets(800, 88)).toEqual({ full: 0, half: 400, peek: 712 });
  });

  it('never returns a negative peek offset', () => {
    expect(snapOffsets(50, 88).peek).toBe(0);
  });
});

describe('resolveSnap', () => {
  const offsets = snapOffsets(800, 88);

  it('settles a slow release on the nearest snap', () => {
    expect(resolveSnap({ offset: 380, velocity: 0, from: 'peek', offsets })).toBe('half');
    expect(resolveSnap({ offset: 90, velocity: 0, from: 'half', offsets })).toBe('full');
    expect(resolveSnap({ offset: 650, velocity: 0, from: 'half', offsets })).toBe('peek');
  });

  it('moves a flick one snap in its direction', () => {
    expect(resolveSnap({ offset: 690, velocity: -1, from: 'peek', offsets })).toBe('half');
    expect(resolveSnap({ offset: 30, velocity: 1, from: 'full', offsets })).toBe('half');
  });

  it('does not run past either end', () => {
    expect(resolveSnap({ offset: 0, velocity: -2, from: 'full', offsets })).toBe('full');
    expect(resolveSnap({ offset: 712, velocity: 2, from: 'peek', offsets })).toBe('peek');
  });
});

describe('ResultsSheet', () => {
  it('is a labelled region, not a dialog — the page behind it stays usable', () => {
    renderSheet('peek');
    expect(screen.getByRole('region', { name: 'Results' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('makes the off-screen body inert at peek only', () => {
    renderSheet('peek');
    expect(screen.getByTestId('results-sheet-body')).toHaveAttribute('inert');
  });

  it('leaves the body reachable once raised', () => {
    renderSheet('half');
    expect(screen.getByTestId('results-sheet-body')).not.toHaveAttribute('inert');
  });

  it('expands from peek to full and collapses back from the handle button', async () => {
    const onSnapChange = renderSheet('peek');
    await userEvent.click(screen.getByRole('button', { name: 'Expand results' }));
    expect(onSnapChange).toHaveBeenLastCalledWith('full');
  });

  it('collapses to peek from any raised snap', async () => {
    const onSnapChange = renderSheet('half');
    const handle = screen.getByRole('button', { name: 'Collapse results' });
    expect(handle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(handle);
    expect(onSnapChange).toHaveBeenLastCalledWith('peek');
  });

  describe('dragging the header', () => {
    // happy-dom does no layout: an 800px sheet with an 88px header gives
    // offsets full 0 / half 400 / peek 712.
    let spy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      spy = vi
        .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.dataset.testid === 'results-sheet' ? 800 : 88;
        });
    });
    afterEach(() => spy.mockRestore());

    // The sheet times a drag with `performance.now()`; step it per event so a
    // test decides whether a release is a slow drag or a flick.
    const drag = (from: number, to: number, duration: number) => {
      const area = screen.getByTestId('results-sheet-drag-area');
      const now = vi.spyOn(performance, 'now');
      now.mockReturnValue(1000);
      fireEvent.pointerDown(area, { pointerId: 1, clientY: from, button: 0 });
      now.mockReturnValue(1000 + duration / 2);
      fireEvent.pointerMove(area, { pointerId: 1, clientY: (from + to) / 2 });
      now.mockReturnValue(1000 + duration);
      fireEvent.pointerUp(area, { pointerId: 1, clientY: to });
      now.mockRestore();
    };

    it('settles a slow drag up from peek at half', () => {
      const onSnapChange = renderSheet('peek');
      drag(760, 430, 2000);
      expect(onSnapChange).toHaveBeenLastCalledWith('half');
    });

    it('settles a slow drag down from half at peek', () => {
      const onSnapChange = renderSheet('half');
      drag(420, 700, 2000);
      expect(onSnapChange).toHaveBeenLastCalledWith('peek');
    });

    it('moves one snap down on a fast downward flick', () => {
      const onSnapChange = renderSheet('full');
      drag(10, 200, 100);
      expect(onSnapChange).toHaveBeenLastCalledWith('half');
    });

    it('treats a press that barely moves as a click, not a drag', () => {
      const onSnapChange = renderSheet('half');
      drag(300, 302, 50);
      expect(onSnapChange).not.toHaveBeenCalled();
    });

    it('does not report a change when released back at its own snap', () => {
      const onSnapChange = renderSheet('half');
      drag(400, 440, 2000);
      expect(onSnapChange).not.toHaveBeenCalled();
    });
  });
});
