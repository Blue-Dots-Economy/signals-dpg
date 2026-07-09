import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';

const submitSupport = vi.fn();
vi.mock('@/lib/support-api', () => ({ submitSupport: (...a: unknown[]) => submitSupport(...a) }));

// Sonner's toast.*() calls render into whatever <Toaster /> is mounted in the
// document; in the real app that's the one in app.tsx. Mount the plain
// sonner Toaster here so toast content is actually observable in the DOM.
async function renderDialog() {
  const { SupportDialog } = await import('../support-dialog');
  render(
    <>
      <Toaster />
      <SupportDialog open={true} onOpenChange={() => {}} />
    </>,
  );
}

describe('SupportDialog', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does not submit when the message is empty', async () => {
    await renderDialog();
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(submitSupport).not.toHaveBeenCalled();
  });

  it('submits the message and calls submitSupport', async () => {
    submitSupport.mockResolvedValue(undefined);
    await renderDialog();
    await userEvent.type(screen.getByLabelText(/message/i), 'It broke');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(submitSupport).toHaveBeenCalledWith({ subject: undefined, message: 'It broke' }));
  });

  it('shows the unavailable message on a 503 response', async () => {
    submitSupport.mockRejectedValue({ isAxiosError: true, response: { status: 503 } });
    await renderDialog();
    await userEvent.type(screen.getByLabelText(/message/i), 'hi');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() =>
      expect(screen.getAllByText(/isn't available|unavailable/i).length).toBeGreaterThan(0),
    );
  });
});
