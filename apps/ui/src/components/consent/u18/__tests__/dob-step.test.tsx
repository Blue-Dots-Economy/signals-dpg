import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pickBirthYear } from '@/test/pick-dob';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';

const submitU18Dob = vi.fn();
vi.mock('@/lib/consent-api', () => ({
  submitU18Dob: (...args: unknown[]) => submitU18Dob(...args),
}));

const CURRENT_YEAR = new Date().getFullYear();

async function renderDobStep(onResolved: (isMinor: boolean) => void) {
  const { DobStep } = await import('../dob-step');
  render(
    <>
      <Toaster />
      <DobStep network="blue_dot" onResolved={onResolved} />
    </>,
  );
}

describe('DobStep (birth year → age, #331)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('picking a year enables Continue (no month asked)', async () => {
    await renderDobStep(vi.fn());
    const submit = screen.getByRole('button', { name: /continue/i });
    expect(submit).toBeDisabled();
    await pickBirthYear(2012);
    expect(screen.queryByRole('combobox', { name: /birth month/i })).toBeNull();
    expect(submit).toBeEnabled();
  });

  it('submits the derived age (currentYear - birthYear)', async () => {
    submitU18Dob.mockResolvedValue({ isMinor: true });
    const onResolved = vi.fn();
    await renderDobStep(onResolved);

    await pickBirthYear(2012);
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() =>
      expect(submitU18Dob).toHaveBeenCalledWith(
        expect.objectContaining({ network: 'blue_dot', age: CURRENT_YEAR - 2012 }),
      ),
    );
    expect(onResolved).toHaveBeenCalledWith(true);
  });

  it('reports isMinor=false from the response for an adult', async () => {
    submitU18Dob.mockResolvedValue({ isMinor: false });
    const onResolved = vi.fn();
    await renderDobStep(onResolved);

    await pickBirthYear(1990);
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(false));
  });

  it('shows an error toast and does not resolve when the request fails', async () => {
    submitU18Dob.mockRejectedValue(new Error('network down'));
    const onResolved = vi.fn();
    await renderDobStep(onResolved);

    await pickBirthYear(2012);
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByText(/couldn't save/i)).toBeInTheDocument());
    expect(onResolved).not.toHaveBeenCalled();
  });
});
