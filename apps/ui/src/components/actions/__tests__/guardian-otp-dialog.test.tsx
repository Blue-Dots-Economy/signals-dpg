import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Toaster } from 'sonner';
import type { DotActionSchema } from '@/engine/types';

// action-handler.tsx and guardian-otp-dialog.tsx both classify a thrown error
// via `guardianOtpErrorFromThrown` from `@/lib/action-api` — mock it so the
// test controls classification directly instead of depending on axios/bulk
// internals.
vi.mock('@/lib/action-api', () => ({
  guardianOtpErrorFromThrown: (err: unknown) => {
    const code = (err as { code?: string } | null | undefined)?.code;
    const known = [
      'GUARDIAN_OTP_REQUIRED',
      'GUARDIAN_OTP_INVALID',
      'GUARDIAN_OTP_THROTTLED',
      'GUARDIAN_OTP_RATE_LIMITED',
      'OTP_PROVIDER_UNAVAILABLE',
    ];
    return code && known.includes(code) ? code : null;
  },
}));

function guardianOtpError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

// A schema with no requirement_schema takes ActionHandler's "no form needed,
// submit directly" branch, so the test can trigger the action with a single
// click instead of driving the RJSF form.
const noFormSchema = {
  action_type: 'connect',
  from_domain: 'student',
  to_domain: 'mentor',
  requirement_schema: undefined,
} as unknown as DotActionSchema;

async function renderHandler(
  onActionSubmit: (
    actionType: string,
    actionSchema: DotActionSchema,
    formData: Record<string, unknown>,
    targetItemId: string,
    guardianOtp?: string,
  ) => Promise<void> | void,
) {
  const { ActionHandler } = await import('../action-handler');
  render(
    <>
      <Toaster />
      <ActionHandler onActionSubmit={onActionSubmit}>
        {(triggerAction) => (
          <button onClick={() => triggerAction('connect', noFormSchema, 'target-1')}>Connect</button>
        )}
      </ActionHandler>
    </>,
  );
}

function typeOtp(digits: string) {
  const inputs = screen.getAllByRole('textbox');
  digits.split('').forEach((d, i) => {
    fireEvent.change(inputs[i], { target: { value: d } });
  });
}

const OTP_DIALOG_TITLE = /guardian's confirmation via otp/i;

describe('Guardian-OTP challenge/response (ActionHandler + GuardianOtpDialog)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the guardian OTP dialog on GUARDIAN_OTP_REQUIRED, and closes it after a successful resubmit with guardianOtp', async () => {
    const onActionSubmit = vi.fn(
      async (
        _type: string,
        _schema: DotActionSchema,
        _formData: Record<string, unknown>,
        _targetId: string,
        guardianOtp?: string,
      ) => {
        if (!guardianOtp) throw guardianOtpError('GUARDIAN_OTP_REQUIRED');
        // Resubmit with the guardian OTP succeeds.
      },
    );
    await renderHandler(onActionSubmit);

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByText(OTP_DIALOG_TITLE)).toBeInTheDocument());

    typeOtp('123456');

    await waitFor(() =>
      expect(onActionSubmit).toHaveBeenLastCalledWith(
        'connect',
        noFormSchema,
        {},
        'target-1',
        '123456',
      ),
    );
    await waitFor(() => expect(screen.queryByText(OTP_DIALOG_TITLE)).not.toBeInTheDocument());
  });

  it('shows an inline error for GUARDIAN_OTP_INVALID and keeps the dialog open for retry', async () => {
    const onActionSubmit = vi.fn(
      async (
        _type: string,
        _schema: DotActionSchema,
        _formData: Record<string, unknown>,
        _targetId: string,
        guardianOtp?: string,
      ) => {
        if (!guardianOtp) throw guardianOtpError('GUARDIAN_OTP_REQUIRED');
        throw guardianOtpError('GUARDIAN_OTP_INVALID');
      },
    );
    await renderHandler(onActionSubmit);

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.getByText(OTP_DIALOG_TITLE)).toBeInTheDocument());

    typeOtp('000000');

    await waitFor(() => expect(screen.getByText(/incorrect code/i)).toBeInTheDocument());
    // The dialog must still be open so the ward can retry.
    expect(screen.getByText(OTP_DIALOG_TITLE)).toBeInTheDocument();
  });

  it('does not open the guardian OTP dialog for a normal (adult) success result', async () => {
    const onActionSubmit = vi.fn().mockResolvedValue(undefined);
    await renderHandler(onActionSubmit);

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(onActionSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(OTP_DIALOG_TITLE)).not.toBeInTheDocument();
  });
});
