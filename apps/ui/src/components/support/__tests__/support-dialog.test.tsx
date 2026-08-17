import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';

const submitSupport = vi.fn();
vi.mock('@/lib/support-api', () => ({
  submitSupport: (...a: unknown[]) => submitSupport(...a),
  fetchSupportConfig: vi.fn(),
}));

// The dialog reads its attachment limits from GET /support/config via this hook;
// stubbing it keeps these tests about the form, not React Query wiring.
const supportConfig = {
  enabled: true,
  maxTotalBytes: 5 * 1024 * 1024,
  maxFiles: 3,
  allowedTypes: ['image/png', 'image/jpeg', 'audio/mpeg'],
};
vi.mock('@/hooks/use-support-config', () => ({
  useSupportConfig: () => ({ config: supportConfig, isLoading: false }),
}));

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

describe('SupportDialog — attachments (#551)', () => {
  const file = (name: string, type: string, bytes = 64) =>
    new File([new Uint8Array(bytes)], name, { type });

  const fillRequired = async () => {
    await userEvent.type(screen.getByLabelText('Details'), 'It broke');
    await userEvent.click(screen.getByRole('checkbox'));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    submitSupport.mockResolvedValue(undefined);
  });

  it('shows the limits from the server config', async () => {
    await renderDialog();
    expect(screen.getByText(/Up to 3 files, 5.0 MB in total/)).toBeInTheDocument();
  });

  it('lists a selected file with its size and sends it base64-encoded', async () => {
    await renderDialog();
    await userEvent.upload(screen.getByLabelText('Attachments (optional)'), [
      file('evidence.png', 'image/png', 1024),
    ]);
    expect(screen.getByText('evidence.png')).toBeInTheDocument();
    expect(screen.getByText('1.0 KB')).toBeInTheDocument();

    await fillRequired();
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(submitSupport).toHaveBeenCalled());
    const payload = submitSupport.mock.calls[0][0];
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0]).toMatchObject({
      filename: 'evidence.png',
      contentType: 'image/png',
    });
    // 1024 zero bytes base64-encode to a 1368-char string.
    expect(payload.attachments[0].data).toHaveLength(1368);
  });

  it('omits attachments from the payload when none are chosen', async () => {
    await renderDialog();
    await fillRequired();
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(submitSupport).toHaveBeenCalled());
    expect(submitSupport.mock.calls[0][0]).not.toHaveProperty('attachments');
  });

  it('removes a chosen file', async () => {
    await renderDialog();
    await userEvent.upload(screen.getByLabelText('Attachments (optional)'), [
      file('a.png', 'image/png'),
    ]);
    await userEvent.click(screen.getByRole('button', { name: /Remove a.png/i }));
    expect(screen.queryByText('a.png')).not.toBeInTheDocument();
  });

  it('rejects a file type outside the allowlist before submitting', async () => {
    await renderDialog();
    // fireEvent rather than userEvent.upload: upload() honours the input's
    // `accept` attribute and would drop the file before the handler runs. The
    // handler's own type check is the backstop for the paths `accept` doesn't
    // cover (drag-and-drop, pickers that let the user override the filter), so
    // it has to be exercised directly.
    fireEvent.change(screen.getByLabelText('Attachments (optional)'), {
      target: { files: [file('notes.pdf', 'application/pdf')] },
    });
    await waitFor(() =>
      expect(screen.getAllByText(/isn't an accepted file type/i).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText('notes.pdf')).not.toBeInTheDocument();
  });

  it('rejects a selection over the total size budget', async () => {
    await renderDialog();
    // Declared size only — the size rule reads File.size, so there is no reason
    // to allocate 6MB in a test process shared with the rest of the suite.
    const oversized = file('big.png', 'image/png', 0);
    Object.defineProperty(oversized, 'size', { value: 6 * 1024 * 1024 });
    await userEvent.upload(screen.getByLabelText('Attachments (optional)'), [oversized]);
    await waitFor(() =>
      expect(screen.getAllByText(/must total no more than 5.0 MB/i).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText('big.png')).not.toBeInTheDocument();
  });

  it('rejects more files than the configured maximum', async () => {
    await renderDialog();
    await userEvent.upload(screen.getByLabelText('Attachments (optional)'), [
      file('a.png', 'image/png'),
      file('b.png', 'image/png'),
      file('c.png', 'image/png'),
      file('d.png', 'image/png'),
    ]);
    await waitFor(() =>
      expect(screen.getAllByText(/at most 3 files/i).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText('a.png')).not.toBeInTheDocument();
  });

  it('surfaces a server-side attachment rejection with its message', async () => {
    submitSupport.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: { error: 'ATTACHMENT_TOO_LARGE', message: 'Attachments must total no more than 1.0 MB.' },
      },
    });
    await renderDialog();
    await fillRequired();
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() =>
      expect(screen.getAllByText(/no more than 1.0 MB/i).length).toBeGreaterThan(0),
    );
  });

  it('shows a rate-limit message on a 429 response', async () => {
    submitSupport.mockRejectedValue({ isAxiosError: true, response: { status: 429 } });
    await renderDialog();
    await fillRequired();
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() =>
      expect(screen.getAllByText(/Too many messages|several messages recently/i).length).toBeGreaterThan(0),
    );
  });

  it('treats a 413 as an over-size attachment rather than a generic failure', async () => {
    submitSupport.mockRejectedValue({ isAxiosError: true, response: { status: 413 } });
    await renderDialog();
    await fillRequired();
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() =>
      expect(screen.getAllByText(/must total no more than 5.0 MB/i).length).toBeGreaterThan(0),
    );
  });
});
