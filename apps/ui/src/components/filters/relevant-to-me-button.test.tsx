import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RelevantToMeButton } from './relevant-to-me-button';

describe('RelevantToMeButton', () => {
  it('reflects the enabled state via aria-checked', () => {
    const { rerender } = render(
      <RelevantToMeButton enabled={false} onChange={() => {}} singleDomainOk />,
    );
    expect(screen.getByRole('switch', { name: /relevant to me/i })).toHaveAttribute('aria-checked', 'false');

    rerender(<RelevantToMeButton enabled onChange={() => {}} singleDomainOk />);
    expect(screen.getByRole('switch', { name: /relevant to me/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('calls onChange with the flipped state on click', () => {
    const onChange = vi.fn();
    render(<RelevantToMeButton enabled={false} onChange={onChange} singleDomainOk />);
    fireEvent.click(screen.getByRole('switch', { name: /relevant to me/i }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('is disabled with an explanatory title when more than one domain is selected', () => {
    render(<RelevantToMeButton enabled onChange={() => {}} singleDomainOk={false} />);
    const toggle = screen.getByRole('switch', { name: /relevant to me/i });
    expect(toggle).toBeDisabled();
    expect(screen.getByTitle(/select a single domain/i)).toBeInTheDocument();
  });

  it('is enabled with the normal description when exactly one domain is selected', () => {
    render(<RelevantToMeButton enabled onChange={() => {}} singleDomainOk />);
    expect(screen.getByRole('switch', { name: /relevant to me/i })).not.toBeDisabled();
    expect(screen.getByTitle(/show only map results/i)).toBeInTheDocument();
  });
});
