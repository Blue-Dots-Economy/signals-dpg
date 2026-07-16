import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileConsentModal } from '@/components/consent/profile-consent-modal';

const STATEMENT = 'I agree to create a profile.';

describe('ProfileConsentModal — adult', () => {
  it('accepts immediately after ticking (no guardian notice)', async () => {
    const onAccept = vi.fn();
    render(<ProfileConsentModal open statement={STATEMENT} onAccept={onAccept} />);

    const accept = screen.getByRole('button', { name: /accept & continue/i });
    expect(accept).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox'));
    expect(accept).toBeEnabled();

    await userEvent.click(accept);
    expect(onAccept).toHaveBeenCalledOnce();
  });
});

describe('ProfileConsentModal — minor', () => {
  it('ticking reveals the under-18 notice; onAccept only fires from "Verify with guardian"', async () => {
    const onAccept = vi.fn();
    render(<ProfileConsentModal open minor statement={STATEMENT} onAccept={onAccept} />);

    // Age isn't surfaced up front — the ordinary consent title + checkbox show.
    expect(screen.getByText(/confirm your profile consent/i)).toBeInTheDocument();
    const accept = screen.getByRole('button', { name: /accept & continue/i });
    expect(accept).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(accept);

    // Ticking does NOT self-accept — it reveals the guardian-verification notice.
    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.getByText(/guardian confirmation needed/i)).toBeInTheDocument();
    expect(screen.getByText(/under 18/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /verify with guardian/i }));
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it('resets to the checkbox step when reopened for a new profile', async () => {
    const onAccept = vi.fn();
    const { rerender } = render(
      <ProfileConsentModal open={false} minor statement={STATEMENT} onAccept={onAccept} />,
    );
    rerender(<ProfileConsentModal open minor statement={STATEMENT} onAccept={onAccept} />);

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /accept & continue/i }));
    expect(screen.getByRole('button', { name: /verify with guardian/i })).toBeInTheDocument();

    // Close then reopen — back to the tick step, notice gone.
    rerender(<ProfileConsentModal open={false} minor statement={STATEMENT} onAccept={onAccept} />);
    rerender(<ProfileConsentModal open minor statement={STATEMENT} onAccept={onAccept} />);
    expect(screen.queryByRole('button', { name: /verify with guardian/i })).toBeNull();
    expect(screen.getByRole('button', { name: /accept & continue/i })).toBeDisabled();
  });
});
