import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';

const submitU18Dob = vi.fn();
vi.mock('@/lib/consent-api', () => ({
  submitU18Dob: (...args: unknown[]) => submitU18Dob(...args),
}));

const BOUNDARY_YEAR = new Date().getFullYear() - 18; // turns 18 this year

async function renderDobStep(onResolved: (isMinor: boolean) => void) {
  const { DobStep } = await import('../dob-step');
  render(
    <>
      <Toaster />
      <DobStep network="blue_dot" onResolved={onResolved} />
    </>,
  );
}

describe('DobStep (year + conditional month, #331)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('year alone enables Continue for a non-boundary year (no month asked)', async () => {
    await renderDobStep(vi.fn());
    const submit = screen.getByRole('button', { name: /continue/i });
    expect(submit).toBeDisabled();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /birth year/i }), '2012');
    expect(screen.queryByRole('combobox', { name: /birth month/i })).toBeNull();
    expect(submit).toBeEnabled();
  });

  it('boundary year requires the month before Continue enables', async () => {
    await renderDobStep(vi.fn());
    const submit = screen.getByRole('button', { name: /continue/i });
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /birth year/i }),
      String(BOUNDARY_YEAR),
    );
    const month = screen.getByRole('combobox', { name: /birth month/i });
    expect(submit).toBeDisabled();
    await userEvent.selectOptions(month, '7');
    expect(submit).toBeEnabled();
  });

  it('submits year-only as the end of December (last day of month)', async () => {
    submitU18Dob.mockResolvedValue({ isMinor: true });
    const onResolved = vi.fn();
    await renderDobStep(onResolved);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /birth year/i }), '2012');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() =>
      expect(submitU18Dob).toHaveBeenCalledWith(
        expect.objectContaining({ network: 'blue_dot', dateOfBirth: '2012-12-31' }),
      ),
    );
    expect(onResolved).toHaveBeenCalledWith(true);
  });

  it('submits boundary year + month as the last day of that month', async () => {
    submitU18Dob.mockResolvedValue({ isMinor: true });
    await renderDobStep(vi.fn());

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /birth year/i }),
      String(BOUNDARY_YEAR),
    );
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /birth month/i }), '7');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() =>
      expect(submitU18Dob).toHaveBeenCalledWith(
        expect.objectContaining({ dateOfBirth: `${BOUNDARY_YEAR}-07-31` }),
      ),
    );
  });

  it('reports isMinor=false from the response for an adult', async () => {
    submitU18Dob.mockResolvedValue({ isMinor: false });
    const onResolved = vi.fn();
    await renderDobStep(onResolved);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /birth year/i }), '1990');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(false));
  });

  it('shows an error toast and does not resolve when the request fails', async () => {
    submitU18Dob.mockRejectedValue(new Error('network down'));
    const onResolved = vi.fn();
    await renderDobStep(onResolved);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /birth year/i }), '2012');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByText(/couldn't save/i)).toBeInTheDocument());
    expect(onResolved).not.toHaveBeenCalled();
  });
});
