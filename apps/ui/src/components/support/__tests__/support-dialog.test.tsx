import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';

const submitSupport = vi.fn();
vi.mock('@/lib/support-api', () => ({ submitSupport: (...a: unknown[]) => submitSupport(...a) }));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    user: { name: 'Asha K', email: 'asha@example.com', phoneNumber: '+919000000000' },
  }),
}));

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

  it('prefills name/email/phone from the logged-in user', async () => {
    await renderDialog();
    expect(screen.getByLabelText('Name')).toHaveValue('Asha K');
    expect(screen.getByLabelText('Email')).toHaveValue('asha@example.com');
    expect(screen.getByLabelText('Phone')).toHaveValue('+919000000000');
  });

  it('renders the type options and consent checkbox', async () => {
    await renderDialog();
    expect(screen.getByRole('radio', { name: /complaint/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /support request/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('keeps submit disabled until details and consent are provided', async () => {
    await renderDialog();
    const submit = screen.getByRole('button', { name: /send/i });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Details'), 'It broke');
    expect(submit).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox'));
    expect(submit).toBeEnabled();
  });

  it('submits the new payload and calls submitSupport', async () => {
    submitSupport.mockResolvedValue(undefined);
    await renderDialog();
    await userEvent.type(screen.getByLabelText('Details'), 'It broke');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() =>
      expect(submitSupport).toHaveBeenCalledWith({
        name: 'Asha K',
        email: 'asha@example.com',
        phone: '+919000000000',
        type: 'complaint',
        details: 'It broke',
        consent: true,
      }),
    );
  });

  it('shows the unavailable message on a 503 response', async () => {
    submitSupport.mockRejectedValue({ isAxiosError: true, response: { status: 503 } });
    await renderDialog();
    await userEvent.type(screen.getByLabelText('Details'), 'hi');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() =>
      expect(screen.getAllByText(/isn't available|unavailable/i).length).toBeGreaterThan(0),
    );
  });
});
