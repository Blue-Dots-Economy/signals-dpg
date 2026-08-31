import * as React from 'react';
import { Copy, ExternalLink, FileText, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { registerWalletProvider } from '@/engine/wallet/wallet-registry';
import type { WalletImportProviderProps, WalletProvider } from '@/engine/wallet/types';
import {
  digiLockerApi,
  getDigiLockerCallbackOrigins,
  isDigiLockerConfigured,
} from '@/lib/digilocker-api';

/**
 * Shape of an OAuth 2.0 authorization code, used to keep a malformed or hostile
 * cross-window payload from being forwarded to the agent as a "code".
 *
 * RFC 6749 defines the code as `1*VSCHAR`, and `VSCHAR = %x20-7E` — which does
 * include the space character. `[!-~]` (`%x21-7E`) is therefore deliberately
 * one character stricter than the RFC: a space arriving here is essentially
 * always a `+` that `URLSearchParams.get()` decoded, not something the issuer
 * sent, and forwarding it would fail at the agent anyway.
 *
 * The length bound is a sanity limit on untrusted input, not a spec limit —
 * neither the Meri Pehchaan nor the DigiLocker partner API publishes a maximum
 * code length, so it is set far above any realistic code (~50x a typical one)
 * rather than guessed tight. A code that misses either check is still shown to
 * the user (see the message handler) instead of being dropped in silence.
 */
const AUTH_CODE_PATTERN = /^[!-~]{1,4096}$/;

function extractCode(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    const code = parsed.searchParams.get('code');
    if (code) return code;
  } catch {
    // Ignore invalid URL and treat the value as a raw code.
  }
  return trimmed;
}

function isRedirectMessage(data: unknown): data is { type: string; code?: string; finalUrl?: string } {
  return typeof data === 'object' && data !== null && 'type' in data;
}

function detectCodeFromMessage(data: unknown): string | null {
  if (isRedirectMessage(data)) {
    if (data.type === 'DIGILOCKER_REDIRECT' && typeof data.code === 'string') {
      return data.code;
    }
    if (typeof data.finalUrl === 'string') {
      return extractCode(data.finalUrl);
    }
  }

  if (typeof data === 'string' && data.includes('wallet-redirect?code=')) {
    return extractCode(data);
  }

  try {
    const serialized = JSON.stringify(data);
    const match = serialized.match(/wallet-redirect\?[^"\s]*code=([^&"\s]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Whether a code lifted out of a bridge message is shaped like an auth code. */
function isAuthCodeShaped(code: string): boolean {
  return AUTH_CODE_PATTERN.test(code);
}

function DigiLockerProvider({ onSuccess, onCancel }: WalletImportProviderProps) {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = React.useState(false);
  const [authCode, setAuthCode] = React.useState('');
  const [launchUrl, setLaunchUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isMonitoring, setIsMonitoring] = React.useState(false);
  const popupRef = React.useRef<Window | null>(null);
  const pollIntervalRef = React.useRef<number | null>(null);
  const timeoutRef = React.useRef<number | null>(null);

  const cleanupPopup = React.useCallback((closeWindow: boolean) => {
    if (pollIntervalRef.current) {
      window.clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (closeWindow && popupRef.current && !popupRef.current.closed) {
      popupRef.current.close();
    }
    popupRef.current = null;
    setIsMonitoring(false);
  }, []);

  const completeImport = React.useCallback(
    async (input: string) => {
      if (!digiLockerApi) return;
      const code = extractCode(input);
      if (!code) return;

      setIsLoading(true);
      setError(null);
      try {
        const response = await digiLockerApi.completeAuth(code);
        const transformed = digiLockerApi.transformCredentialSubject(response.data.credentialSubject);
        onSuccess({
          data: transformed.data,
          candidates: transformed.candidates,
          rawPayload: transformed.rawPayload,
          providerName: 'digilocker',
          providerLabel: 'DigiLocker',
          metadata: { provider: 'digilocker' },
          summary: t('wallet.digilocker_summary'),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : t('wallet.digilocker_error_complete'));
      } finally {
        setIsLoading(false);
      }
    },
    [onSuccess]
  );

  React.useEffect(() => {
    // Any window can postMessage to us, so the payload is only trusted when it
    // came from an origin the DigiLocker callback can legitimately run on.
    const allowedOrigins = new Set(getDigiLockerCallbackOrigins());
    const handleMessage = (event: MessageEvent) => {
      if (!allowedOrigins.has(event.origin)) return;
      const detectedCode = detectCodeFromMessage(event.data);
      if (!detectedCode) return;
      // Fill the field either way. A code that fails the shape check is not
      // auto-submitted, but it stays visible so the user can check it and use
      // the manual-paste button — rather than the panel sitting on "waiting…"
      // until the ten-minute timeout with no signal that anything arrived.
      setAuthCode(detectedCode);
      if (!isAuthCodeShaped(detectedCode)) return;
      cleanupPopup(true);
      void completeImport(detectedCode);
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      cleanupPopup(true);
    };
  }, [cleanupPopup, completeImport]);

  const startFlow = async () => {
    if (!digiLockerApi) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await digiLockerApi.initiateRequest();
      setLaunchUrl(response.url);
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
      popupRef.current = window.open(
        response.url,
        'digilocker-auth',
        'width=900,height=700,scrollbars=yes,resizable=yes,toolbar=no,menubar=no,location=yes'
      );
      if (!popupRef.current) {
        setError(t('wallet.digilocker_popup_blocked'));
        return;
      }
      setIsMonitoring(true);

      pollIntervalRef.current = window.setInterval(() => {
        if (!popupRef.current || popupRef.current.closed) {
          cleanupPopup(false);
          return;
        }

        try {
          const popupUrl = popupRef.current.location.href;
          if (popupUrl.includes('wallet-redirect?code=')) {
            const detectedCode = extractCode(popupUrl);
            if (detectedCode) {
              setAuthCode(detectedCode);
              cleanupPopup(true);
              void completeImport(detectedCode);
            }
          }
        } catch {
          // Cross-origin access is expected until the popup reaches the redirect page.
        }
      }, 1000);

      timeoutRef.current = window.setTimeout(() => {
        cleanupPopup(true);
        setError(t('wallet.digilocker_timeout'));
      }, 600000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('wallet.digilocker_error_start'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/30 p-4">
        <div className="flex items-center gap-3">
          <div className="rounded-full bg-primary/10 p-2 text-primary">
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <p className="font-medium">{t('wallet.digilocker_title')}</p>
            <p className="text-sm text-muted-foreground">
              {t('wallet.digilocker_subtitle')}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Button variant="outline" onClick={startFlow} disabled={isLoading}>
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
          {t('wallet.digilocker_open_btn')}
        </Button>
        {launchUrl ? (
          <p className="text-xs text-muted-foreground">
            {isMonitoring
              ? t('wallet.digilocker_waiting')
              : t('wallet.digilocker_manual_hint')}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t('wallet.digilocker_code_label')}</p>
        <Input
          value={authCode}
          onChange={(event) => setAuthCode(event.target.value)}
          placeholder={t('wallet.digilocker_code_placeholder')}
        />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {launchUrl ? (
        <div className="rounded-md border p-3 text-xs text-muted-foreground">
          <p>
            {t('wallet.digilocker_bridge_hint')}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(launchUrl);
              } catch {
                setError(t('wallet.digilocker_copy_error'));
              }
            }}
          >
            <Copy className="h-4 w-4" />
            {t('wallet.digilocker_copy_url')}
          </Button>
        </div>
      ) : null}

      <div className="flex justify-between gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button onClick={() => void completeImport(authCode)} disabled={!authCode.trim() || isLoading}>
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t('wallet.digilocker_import_btn')}
        </Button>
      </div>
    </div>
  );
}

const provider: WalletProvider = {
  name: 'digilocker',
  label: 'DigiLocker',
  description: 'Import verified identity details from DigiLocker.',
  component: DigiLockerProvider,
  isConfigured: isDigiLockerConfigured,
  getConfigurationHint: () => 'Missing VITE_AGENT_URL or VITE_AGENT_TOKEN.',
};

registerWalletProvider(provider);
