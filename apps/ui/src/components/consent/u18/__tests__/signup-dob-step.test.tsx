import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { pickBirthYear } from '@/test/pick-dob';
import { SignupDobStep } from '../signup-dob-step';

describe('SignupDobStep', () => {
  it('Continue without a year says it is required under the select and does not proceed', async () => {
    const onSubmit = vi.fn();
    render(<SignupDobStep onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(screen.getByText('Birth year is required.')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-invalid', 'true');
    expect(onSubmit).not.toHaveBeenCalled();

    await pickBirthYear(2000);
    expect(screen.queryByText('Birth year is required.')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(onSubmit).toHaveBeenCalledWith(new Date().getFullYear() - 2000);
  });
});
