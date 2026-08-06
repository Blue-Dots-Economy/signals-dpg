import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WalletImportContext, WalletImportResult } from '@/engine/wallet/types';
import { getWalletProvider } from '@/engine/wallet/wallet-registry';
import { digiLockerApi } from '@/lib/digilocker-api';
import { walletApi, type WalletCredential, type WalletCredentialData } from '@/lib/wallet-api';
// Importing the provider modules is what registers them in the wallet
// registry; the components themselves are not exported.
import '../dhiway-wallet-provider';
import '../digilocker-provider';

// Both provider modules read a module-level singleton (`digiLockerApi` /
// `walletApi`) that is `null` unless the VITE_* env vars are set, so the whole
// flow is dead code unless the api module is mocked with a live object.
// Factories must not touch outer bindings (they hoist), hence the bare vi.fn()s
// with implementations installed in beforeEach.
vi.mock('@/lib/digilocker-api', () => ({
  digiLockerApi: {
    initiateRequest: vi.fn(),
    completeAuth: vi.fn(),
    transformCredentialSubject: vi.fn(),
  },
  isDigiLockerConfigured: () => true,
}));

vi.mock('@/lib/wallet-api', () => ({
  walletApi: {
    requestCode: vi.fn(),
    verifyCode: vi.fn(),
    getVerifiedCredentials: vi.fn(),
    setAuthToken: vi.fn(),
    clearAuthToken: vi.fn(),
    transformSelectedCredential: vi.fn(),
  },
  isWalletConfigured: () => true,
}));

const digilocker = vi.mocked(digiLockerApi as NonNullable<typeof digiLockerApi>);
const wallet = vi.mocked(walletApi as NonNullable<typeof walletApi>);

function getProvider(name: string) {
  const provider = getWalletProvider(name);
  if (!provider) throw new Error(`wallet provider "${name}" was not registered`);
  return provider;
}

// The app is schema-driven: the import context always carries the network
// schema/form data even though these two providers only read `context.user`.
function makeContext(
  user: Partial<WalletImportContext['user']> = {},
): WalletImportContext {
  return {
    user: { email: 'asha@example.org', phoneNumber: null, name: 'Asha Kumar', ...user },
    networkId: 'yellow_dot',
    domainId: 'student',
    schema: {
      type: 'object',
      properties: { full_name: { type: 'string', title: 'Full name' } },
    },
    formData: {},
  };
}

function renderProvider(name: string, context: WalletImportContext) {
  const onSuccess = vi.fn((_result: WalletImportResult) => undefined);
  const onCancel = vi.fn(() => undefined);
  const Provider = getProvider(name).component;
  render(<Provider context={context} onSuccess={onSuccess} onCancel={onCancel} />);
  return { onSuccess, onCancel };
}

interface FakePopup {
  closed: boolean;
  close: () => void;
  location: { href: string };
}

function makePopup(href = 'https://digilocker.example/authorize'): FakePopup {
  return { closed: false, close: vi.fn(), location: { href } };
}

function openReturns(popup: FakePopup | null) {
  return vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
}

beforeEach(() => {
  // restore first (drops the per-test window.open / clipboard spies), then
  // reset so a mockResolvedValue from a previous test can't leak forward.
  vi.restoreAllMocks();
  vi.resetAllMocks();
  digilocker.transformCredentialSubject.mockImplementation(
    (subject: Record<string, unknown>) => ({
      data: {},
      candidates: { full_name: subject.name },
      rawPayload: subject,
    }),
  );
  wallet.transformSelectedCredential.mockImplementation(
    (credentialData: WalletCredentialData, credential: WalletCredential) => ({
      data: {},
      candidates: { full_name: credential.credentialSubject?.name },
      rawPayload: { credential, credentialData },
      metadata: { credentialId: credential.id, provider: 'dhiway-wallet' },
      summary: 'Diploma Certificate from City College Board',
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('wallet provider registry entries', () => {
  it('registers digilocker and dhiway-wallet with labels and config hints', () => {
    const digilockerProvider = getProvider('digilocker');
    expect(digilockerProvider.label).toBe('DigiLocker');
    expect(digilockerProvider.isConfigured()).toBe(true);
    expect(digilockerProvider.getConfigurationHint?.()).toContain('VITE_AGENT_URL');

    const dhiwayProvider = getProvider('dhiway-wallet');
    expect(dhiwayProvider.label).toBe('Dhiway Wallet');
    expect(dhiwayProvider.isConfigured()).toBe(true);
    expect(dhiwayProvider.getConfigurationHint?.()).toContain('VITE_VC_WALLET_URL');
  });
});

describe('DigiLockerProvider', () => {
  function renderDigiLocker() {
    return renderProvider('digilocker', makeContext());
  }

  it('starts with the import button disabled until a code is present', async () => {
    renderDigiLocker();

    expect(screen.getByText('DigiLocker')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import from DigiLocker' })).toBeDisabled();
    // No flow started yet, so neither the waiting nor the manual hint shows.
    expect(screen.queryByText(/automatic detection/)).not.toBeInTheDocument();

    await userEvent.type(
      screen.getByPlaceholderText('Paste the code or redirect URL here'),
      'PASTED',
    );
    expect(screen.getByRole('button', { name: 'Import from DigiLocker' })).toBeEnabled();
  });

  it('imports a manually pasted authorization code', async () => {
    digilocker.completeAuth.mockResolvedValue({
      data: { credentialSubject: { name: 'Asha Kumar' } },
    });
    const { onSuccess } = renderDigiLocker();

    await userEvent.type(
      screen.getByPlaceholderText('Paste the code or redirect URL here'),
      'RAW_CODE_1',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Import from DigiLocker' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(digilocker.completeAuth).toHaveBeenCalledWith('RAW_CODE_1');
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        providerName: 'digilocker',
        providerLabel: 'DigiLocker',
        metadata: { provider: 'digilocker' },
        summary: 'Imported verified details from DigiLocker',
        candidates: { full_name: 'Asha Kumar' },
        rawPayload: { name: 'Asha Kumar' },
      }),
    );
  });

  it('extracts the code when a full redirect URL is pasted', async () => {
    digilocker.completeAuth.mockResolvedValue({ data: { credentialSubject: {} } });
    const { onSuccess } = renderDigiLocker();

    await userEvent.type(
      screen.getByPlaceholderText('Paste the code or redirect URL here'),
      'https://app.example.org/wallet-redirect?code=FROM_URL&state=xyz',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Import from DigiLocker' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(digilocker.completeAuth).toHaveBeenCalledWith('FROM_URL');
  });

  it('surfaces the api error message when completing the import fails', async () => {
    digilocker.completeAuth.mockRejectedValue(new Error('DigiLocker rejected the code'));
    const { onSuccess } = renderDigiLocker();

    await userEvent.type(
      screen.getByPlaceholderText('Paste the code or redirect URL here'),
      'BAD_CODE',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Import from DigiLocker' }));

    expect(await screen.findByText('DigiLocker rejected the code')).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
    // The button is re-enabled so the user can retry.
    expect(screen.getByRole('button', { name: 'Import from DigiLocker' })).toBeEnabled();
  });

  it('falls back to a generic message when the rejection is not an Error', async () => {
    digilocker.completeAuth.mockRejectedValue('kaboom');
    renderDigiLocker();

    await userEvent.type(
      screen.getByPlaceholderText('Paste the code or redirect URL here'),
      'BAD_CODE',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Import from DigiLocker' }));

    expect(await screen.findByText('Failed to complete DigiLocker import')).toBeInTheDocument();
  });

  it('opens the DigiLocker popup and shows the waiting hint', async () => {
    const popup = makePopup();
    const openSpy = openReturns(popup);
    digilocker.initiateRequest.mockResolvedValue({ url: 'https://digilocker.example/start?r=1' });
    renderDigiLocker();

    await userEvent.click(screen.getByRole('button', { name: 'Open DigiLocker' }));

    await waitFor(() =>
      expect(screen.getByText(/^Waiting for DigiLocker to finish/)).toBeInTheDocument(),
    );
    expect(openSpy).toHaveBeenCalledWith(
      'https://digilocker.example/start?r=1',
      'digilocker-auth',
      expect.stringContaining('width=900'),
    );
    // The bridge hint + copy affordance only appear once a launch URL exists.
    expect(screen.getByRole('button', { name: 'Copy launch URL' })).toBeInTheDocument();
  });

  it('reports a blocked popup but still exposes the manual paste hint', async () => {
    openReturns(null);
    digilocker.initiateRequest.mockResolvedValue({ url: 'https://digilocker.example/start?r=2' });
    renderDigiLocker();

    await userEvent.click(screen.getByRole('button', { name: 'Open DigiLocker' }));

    expect(
      await screen.findByText('Popup blocked. Please allow popups for this site and try again.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'If automatic detection does not work, paste the redirect URL or the code below.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Waiting for DigiLocker to finish/)).not.toBeInTheDocument();
  });

  it('shows an error when the launch URL cannot be fetched', async () => {
    const openSpy = openReturns(makePopup());
    digilocker.initiateRequest.mockRejectedValue(new Error('agent unreachable'));
    renderDigiLocker();

    await userEvent.click(screen.getByRole('button', { name: 'Open DigiLocker' }));

    expect(await screen.findByText('agent unreachable')).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Copy launch URL' })).not.toBeInTheDocument();
  });

  it('falls back to a generic start error for non-Error rejections', async () => {
    openReturns(makePopup());
    digilocker.initiateRequest.mockRejectedValue({ status: 500 });
    renderDigiLocker();

    await userEvent.click(screen.getByRole('button', { name: 'Open DigiLocker' }));

    expect(await screen.findByText('Failed to start DigiLocker import')).toBeInTheDocument();
  });

  it('copies the launch URL to the clipboard', async () => {
    openReturns(makePopup());
    digilocker.initiateRequest.mockResolvedValue({ url: 'https://digilocker.example/start?r=3' });
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderDigiLocker();

    await userEvent.click(screen.getByRole('button', { name: 'Open DigiLocker' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Copy launch URL' }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('https://digilocker.example/start?r=3'),
    );
    expect(
      screen.queryByText('Could not copy the DigiLocker URL to the clipboard.'),
    ).not.toBeInTheDocument();
  });

  it('shows a copy error when the clipboard is unavailable', async () => {
    openReturns(makePopup());
    digilocker.initiateRequest.mockResolvedValue({ url: 'https://digilocker.example/start?r=4' });
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    renderDigiLocker();

    await userEvent.click(screen.getByRole('button', { name: 'Open DigiLocker' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Copy launch URL' }));

    expect(
      await screen.findByText('Could not copy the DigiLocker URL to the clipboard.'),
    ).toBeInTheDocument();
  });

  it('calls onCancel when the user cancels', async () => {
    const { onCancel } = renderDigiLocker();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  describe('bridge postMessage handling', () => {
    async function postMessage(data: unknown) {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { data }));
      });
    }

    it('imports from a DIGILOCKER_REDIRECT message and fills the code field', async () => {
      digilocker.completeAuth.mockResolvedValue({ data: { credentialSubject: { name: 'Asha' } } });
      const { onSuccess } = renderDigiLocker();

      await postMessage({ type: 'DIGILOCKER_REDIRECT', code: 'MSG_CODE' });

      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
      expect(digilocker.completeAuth).toHaveBeenCalledWith('MSG_CODE');
      expect(screen.getByPlaceholderText('Paste the code or redirect URL here')).toHaveValue(
        'MSG_CODE',
      );
    });

    it('extracts the code from a message carrying a finalUrl', async () => {
      digilocker.completeAuth.mockResolvedValue({ data: { credentialSubject: {} } });
      renderDigiLocker();

      await postMessage({
        type: 'SOME_BRIDGE_EVENT',
        finalUrl: 'https://app.example.org/wallet-redirect?code=FROM_FINAL_URL',
      });

      await waitFor(() =>
        expect(digilocker.completeAuth).toHaveBeenCalledWith('FROM_FINAL_URL'),
      );
    });

    it('extracts the code from a plain string message', async () => {
      digilocker.completeAuth.mockResolvedValue({ data: { credentialSubject: {} } });
      renderDigiLocker();

      await postMessage('https://app.example.org/wallet-redirect?code=FROM_STRING');

      await waitFor(() => expect(digilocker.completeAuth).toHaveBeenCalledWith('FROM_STRING'));
    });

    it('digs the code out of a nested payload via serialization', async () => {
      digilocker.completeAuth.mockResolvedValue({ data: { credentialSubject: {} } });
      renderDigiLocker();

      await postMessage({
        payload: { nested: { url: 'https://app.example.org/wallet-redirect?code=FROM_NESTED' } },
      });

      await waitFor(() => expect(digilocker.completeAuth).toHaveBeenCalledWith('FROM_NESTED'));
    });

    it('ignores unrelated messages', async () => {
      renderDigiLocker();

      await postMessage({ type: 'UNRELATED', payload: 'nothing to see' });

      expect(digilocker.completeAuth).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText('Paste the code or redirect URL here')).toHaveValue('');
    });
  });

  describe('popup polling', () => {
    async function startFlow(popup: FakePopup | null, url = 'https://digilocker.example/start') {
      openReturns(popup);
      digilocker.initiateRequest.mockResolvedValue({ url });
      const handles = renderProvider('digilocker', makeContext());
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Open DigiLocker' }));
      });
      return handles;
    }

    it('completes the import when the popup reaches the redirect URL', async () => {
      vi.useFakeTimers();
      digilocker.completeAuth.mockResolvedValue({
        data: { credentialSubject: { name: 'Polled Asha' } },
      });
      const popup = makePopup();
      const { onSuccess } = await startFlow(popup);
      expect(screen.getByText(/^Waiting for DigiLocker to finish/)).toBeInTheDocument();

      popup.location.href = 'https://app.example.org/wallet-redirect?code=POLLED_CODE';
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      await act(async () => {});

      expect(digilocker.completeAuth).toHaveBeenCalledWith('POLLED_CODE');
      expect(vi.mocked(popup.close)).toHaveBeenCalledTimes(1);
      expect(onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ candidates: { full_name: 'Polled Asha' } }),
      );
      expect(screen.getByPlaceholderText('Paste the code or redirect URL here')).toHaveValue(
        'POLLED_CODE',
      );
    });

    it('keeps polling while the popup is still on a cross-origin page', async () => {
      vi.useFakeTimers();
      const popup = makePopup();
      Object.defineProperty(popup, 'location', {
        get() {
          throw new Error('cross-origin access blocked');
        },
      });
      await startFlow(popup);

      await act(async () => {
        vi.advanceTimersByTime(5000);
      });

      expect(digilocker.completeAuth).not.toHaveBeenCalled();
      expect(screen.getByText(/^Waiting for DigiLocker to finish/)).toBeInTheDocument();
    });

    it('stops monitoring when the user closes the popup, without importing', async () => {
      vi.useFakeTimers();
      const popup = makePopup();
      const { onSuccess } = await startFlow(popup);

      popup.closed = true;
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(
        screen.getByText(
          'If automatic detection does not work, paste the redirect URL or the code below.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/^Waiting for DigiLocker to finish/)).not.toBeInTheDocument();
      expect(digilocker.completeAuth).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
      // cleanupPopup(false): a popup the user already closed is not closed again.
      expect(vi.mocked(popup.close)).not.toHaveBeenCalled();
    });

    it('times out after ten minutes and closes the popup', async () => {
      vi.useFakeTimers();
      const popup = makePopup();
      await startFlow(popup);

      await act(async () => {
        vi.advanceTimersByTime(600_000);
      });

      expect(
        screen.getByText('DigiLocker authentication timed out. Please try again.'),
      ).toBeInTheDocument();
      expect(vi.mocked(popup.close)).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/^Waiting for DigiLocker to finish/)).not.toBeInTheDocument();
    });
  });
});

describe('DhiwayWalletProvider', () => {
  const credential: WalletCredential = {
    id: 'cred-1',
    issuanceDate: '2026-01-15T00:00:00.000Z',
    credentialSchema: { title: 'Diploma Certificate' },
    credentialSubject: {
      name: 'Asha Kumar',
      college: 'City College',
      score: 88,
      fourth: 'not-previewed',
      nested: { skipped: true },
    },
  };
  const credentialData: WalletCredentialData = {
    id: 42,
    metadata: { orgName: 'City College Board', issuedBy: 'Registrar' },
    credentials: [credential],
  };

  function renderDhiway(user: Partial<WalletImportContext['user']> = {}) {
    return renderProvider('dhiway-wallet', makeContext(user));
  }

  async function reachCredentialsStep(credentials: WalletCredentialData[]) {
    wallet.requestCode.mockResolvedValue({ message: 'sent' });
    wallet.verifyCode.mockResolvedValue({ message: 'ok', token: 'wallet-token' });
    wallet.getVerifiedCredentials.mockResolvedValue({
      total: credentials.length,
      credentials,
    });
    const handles = renderDhiway();
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await userEvent.type(
      await screen.findByPlaceholderText('Enter the code you received'),
      '  123456  ',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Verify and fetch credentials' }));
    return handles;
  }

  it('auto-selects the only identifier and sends a code to it', async () => {
    wallet.requestCode.mockResolvedValue({ message: 'sent' });
    renderDhiway();

    expect(screen.getByText('asha@example.org')).toBeInTheDocument();
    expect(
      screen.getByText('A verification code will be sent to your selected email.'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));

    expect(wallet.requestCode).toHaveBeenCalledWith('asha@example.org', 'email');
    expect(await screen.findByText('Enter verification code')).toBeInTheDocument();
  });

  it('uses the phone identifier when only a phone number is on the account', async () => {
    wallet.requestCode.mockResolvedValue({ message: 'sent' });
    renderDhiway({ email: null, phoneNumber: '+919000000000' });

    expect(
      screen.getByText('A verification code will be sent to your selected phone.'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));

    expect(wallet.requestCode).toHaveBeenCalledWith('+919000000000', 'phone');
  });

  it('requires an explicit choice when both email and phone exist', () => {
    renderDhiway({ email: 'asha@example.org', phoneNumber: '+919000000000' });

    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByText('Select email or phone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send code' })).toBeDisabled();
  });

  it('disables sending when the account has no identifier at all', () => {
    renderDhiway({ email: null, phoneNumber: null });

    expect(screen.getByText('No identifier available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send code' })).toBeDisabled();
  });

  it('shows the api error when requesting a code fails and stays on step one', async () => {
    wallet.requestCode.mockRejectedValue(new Error('wallet is down'));
    renderDhiway();

    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));

    expect(await screen.findByText('wallet is down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send code' })).toBeInTheDocument();
    expect(screen.queryByText('Enter verification code')).not.toBeInTheDocument();
  });

  it('falls back to a generic message for non-Error request failures', async () => {
    wallet.requestCode.mockRejectedValue('nope');
    renderDhiway();

    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));

    expect(await screen.findByText('Failed to send verification code')).toBeInTheDocument();
  });

  it('keeps verification disabled until a non-blank code is typed', async () => {
    wallet.requestCode.mockResolvedValue({ message: 'sent' });
    renderDhiway();
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));

    const verify = await screen.findByRole('button', { name: 'Verify and fetch credentials' });
    expect(verify).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText('Enter the code you received'), '   ');
    expect(verify).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText('Enter the code you received'), '9');
    expect(verify).toBeEnabled();
  });

  it('lets the user go back and change the identifier', async () => {
    wallet.requestCode.mockResolvedValue({ message: 'sent' });
    renderDhiway();
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));

    await userEvent.click(await screen.findByRole('button', { name: 'Change identifier' }));

    expect(screen.getByText('Choose an identifier')).toBeInTheDocument();
    expect(screen.queryByText('Enter verification code')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send code' })).toBeEnabled();
  });

  it('trims the code, stores the token and lists the returned credentials', async () => {
    await reachCredentialsStep([credentialData]);

    expect(await screen.findByText('City College Board')).toBeInTheDocument();
    expect(wallet.verifyCode).toHaveBeenCalledWith('asha@example.org', '123456');
    expect(wallet.setAuthToken).toHaveBeenCalledWith('wallet-token');
    expect(wallet.getVerifiedCredentials).toHaveBeenCalledWith('asha@example.org');

    expect(screen.getByText('Registrar')).toBeInTheDocument();
    expect(screen.getByText('Diploma Certificate')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(
      screen.getByText(`Issued ${new Date('2026-01-15T00:00:00.000Z').toLocaleDateString()}`),
    ).toBeInTheDocument();

    // Preview shows only the first three scalar subject values.
    expect(screen.getByText('Asha Kumar')).toBeInTheDocument();
    expect(screen.getByText('City College')).toBeInTheDocument();
    expect(screen.getByText('88')).toBeInTheDocument();
    expect(screen.queryByText('not-previewed')).not.toBeInTheDocument();
  });

  it('does not set an auth token when the verify response omits one', async () => {
    wallet.requestCode.mockResolvedValue({ message: 'sent' });
    wallet.verifyCode.mockResolvedValue({ message: 'ok' });
    wallet.getVerifiedCredentials.mockResolvedValue({ total: 0, credentials: [] });
    renderDhiway();

    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await userEvent.type(
      await screen.findByPlaceholderText('Enter the code you received'),
      '123456',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Verify and fetch credentials' }));

    expect(await screen.findByText('No verified credentials were found.')).toBeInTheDocument();
    expect(wallet.setAuthToken).not.toHaveBeenCalled();
  });

  it('shows the api error when verification fails and stays on the code step', async () => {
    wallet.requestCode.mockResolvedValue({ message: 'sent' });
    wallet.verifyCode.mockRejectedValue(new Error('That code has expired'));
    renderDhiway();

    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await userEvent.type(
      await screen.findByPlaceholderText('Enter the code you received'),
      '000000',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Verify and fetch credentials' }));

    expect(await screen.findByText('That code has expired')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter the code you received')).toBeInTheDocument();
    expect(wallet.getVerifiedCredentials).not.toHaveBeenCalled();
  });

  it('falls back to a generic message for non-Error verification failures', async () => {
    wallet.requestCode.mockResolvedValue({ message: 'sent' });
    wallet.verifyCode.mockRejectedValue({ status: 401 });
    renderDhiway();

    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await userEvent.type(
      await screen.findByPlaceholderText('Enter the code you received'),
      '000000',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Verify and fetch credentials' }));

    expect(await screen.findByText('Failed to verify code')).toBeInTheDocument();
  });

  it('falls back to generic issuer and credential labels when metadata is missing', async () => {
    await reachCredentialsStep([
      { id: 7, credentials: [{ id: 'cred-bare' }] },
    ]);

    expect(await screen.findByText('Credential issuer')).toBeInTheDocument();
    expect(screen.getByText('Wallet credential')).toBeInTheDocument();
    expect(screen.getByText('Credential')).toBeInTheDocument();
    expect(screen.queryByText(/^Issued /)).not.toBeInTheDocument();
  });

  it('hands the selected credential to onSuccess', async () => {
    const { onSuccess } = await reachCredentialsStep([credentialData]);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Import this credential' }),
    );

    expect(wallet.transformSelectedCredential).toHaveBeenCalledWith(credentialData, credential);
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        providerName: 'dhiway-wallet',
        providerLabel: 'Dhiway Wallet',
        summary: 'Diploma Certificate from City College Board',
        candidates: { full_name: 'Asha Kumar' },
        metadata: { credentialId: 'cred-1', provider: 'dhiway-wallet' },
      }),
    );
  });

  it('hides the primary action once credentials are listed', async () => {
    await reachCredentialsStep([credentialData]);

    await screen.findByText('City College Board');
    expect(screen.queryByRole('button', { name: 'Send code' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Verify and fetch credentials' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('calls onCancel when the user cancels', async () => {
    const { onCancel } = renderDhiway();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
