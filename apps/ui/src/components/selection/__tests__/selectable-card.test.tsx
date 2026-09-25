import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SelectableCard } from '../selectable-card';

describe('SelectableCard', () => {
  const card = <div>card body</div>;

  it('renders children untouched outside select mode (no checkbox)', () => {
    render(
      <SelectableCard id="a" selectMode={false} selected={false} onToggle={vi.fn()}>
        {card}
      </SelectableCard>,
    );
    expect(screen.getByText('card body')).toBeInTheDocument();
    expect(screen.queryByTestId('selectable-card-check')).not.toBeInTheDocument();
  });

  it('puts the checkbox on the card corner, outside the content box', () => {
    render(
      <SelectableCard id="a" selectMode selected={false} onToggle={vi.fn()}>
        {card}
      </SelectableCard>,
    );
    const check = screen.getByTestId('selectable-card-check');
    // Negative offsets keep it off the card header (e.g. the action timestamp).
    expect(check.className).toContain('-right-2');
    expect(check.className).toContain('-top-2');
  });

  it('toggles on click and keyboard when selectable', () => {
    const onToggle = vi.fn();
    render(
      <SelectableCard id="a" selectMode selected={false} onToggle={onToggle}>
        {card}
      </SelectableCard>,
    );
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('shows no checkbox and ignores clicks when not selectable', () => {
    const onToggle = vi.fn();
    render(
      <SelectableCard id="a" selectMode selected={false} selectable={false} onToggle={onToggle}>
        {card}
      </SelectableCard>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.queryByTestId('selectable-card-check')).not.toBeInTheDocument();
  });
});
