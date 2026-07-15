import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';

const submitU18Dob = vi.fn();
vi.mock('@/lib/consent-api', () => ({
  submitU18Dob: (...args: unknown[]) => submitU18Dob(...args),
}));

async function renderDobStep(onResolved: (isMinor: boolean) => void) {
  const { DobStep } = await import('../dob-step');
  render(
    <>
      <Toaster />
      <DobStep network="blue_dot" onResolved={onResolved} />
    </>,
  );
}

describe('DobStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables Continue until both month and year are selected', async () => {
    await renderDobStep(vi.fn());
    const submit = screen.getByRole('button', { name: /continue/i });
    expect(submit).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText('Birth month'), 'May');
    expect(submit).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText('Birth year'), '2012');
    expect(submit).toBeEnabled();
  });

  it('submits the selected month/year and reports isMinor=true from the response', async () => {
    submitU18Dob.mockResolvedValue({ isMinor: true });
    const onResolved = vi.fn();
    await renderDobStep(onResolved);

    await userEvent.selectOptions(screen.getByLabelText('Birth month'), 'May');
    await userEvent.selectOptions(screen.getByLabelText('Birth year'), '2012');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() =>
      expect(submitU18Dob).toHaveBeenCalledWith({
        network: 'blue_dot',
        birthYear: 2012,
        birthMonth: 5,
      }),
    );
    expect(onResolved).toHaveBeenCalledWith(true);
  });

  it('reports isMinor=false from the response for an adult', async () => {
    submitU18Dob.mockResolvedValue({ isMinor: false });
    const onResolved = vi.fn();
    await renderDobStep(onResolved);

    await userEvent.selectOptions(screen.getByLabelText('Birth month'), 'January');
    await userEvent.selectOptions(screen.getByLabelText('Birth year'), '1990');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(false));
  });

  it('shows an error toast and does not resolve when the request fails', async () => {
    submitU18Dob.mockRejectedValue(new Error('network down'));
    const onResolved = vi.fn();
    await renderDobStep(onResolved);

    await userEvent.selectOptions(screen.getByLabelText('Birth month'), 'May');
    await userEvent.selectOptions(screen.getByLabelText('Birth year'), '2012');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByText(/couldn't save/i)).toBeInTheDocument());
    expect(onResolved).not.toHaveBeenCalled();
  });
});
