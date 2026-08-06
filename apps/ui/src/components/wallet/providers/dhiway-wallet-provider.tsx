import * as React from 'react';
import { Loader2, Mail, Phone, ShieldCheck, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { registerWalletProvider } from '@/engine/wallet/wallet-registry';
import type { WalletImportProviderProps, WalletProvider } from '@/engine/wallet/types';
import {
  isWalletConfigured,
  walletApi,
  type WalletCredential,
  type WalletCredentialData,
} from '@/lib/wallet-api';

type FlowStep = 'identifier' | 'verify' | 'credentials';

interface IdentifierOption {
  value: string;
  type: 'email' | 'phone';
  label: string;
}

function getIdentifierOptions({ email, phoneNumber }: WalletImportProviderProps['context']['user']): IdentifierOption[] {
  const options: IdentifierOption[] = [];
  if (email) {
    options.push({ value: email, type: 'email', label: email });
  }
  if (phoneNumber) {
    options.push({ value: phoneNumber, type: 'phone', label: phoneNumber });
  }
  return options;
}

function getSchemaTitle(credential: WalletCredential, fallback: string): string {
  const title = credential.credentialSchema?.title;
  return typeof title === 'string' && title.trim() ? title : fallback;
}

function getProviderLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function getPreviewFields(subject: Record<string, unknown> | undefined): string[] {
  if (!subject) return [];
  return Object.values(subject)
    .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
    .slice(0, 3)
    .map((value) => String(value));
}

function DhiwayWalletProvider({ context, onSuccess, onCancel }: WalletImportProviderProps) {
  const { t } = useTranslation();
  const [step, setStep] = React.useState<FlowStep>('identifier');
  const [isLoading, setIsLoading] = React.useState(false);
  const [identifier, setIdentifier] = React.useState('');
  const [identifierType, setIdentifierType] = React.useState<'email' | 'phone'>('email');
  const [verificationCode, setVerificationCode] = React.useState('');
  const [credentialGroups, setCredentialGroups] = React.useState<WalletCredentialData[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const identifierOptions = React.useMemo(() => getIdentifierOptions(context.user), [context.user]);

  React.useEffect(() => {
    if (identifierOptions.length === 1) {
      setIdentifier(identifierOptions[0].value);
      setIdentifierType(identifierOptions[0].type);
    }
  }, [identifierOptions]);

  const requestCode = async () => {
    if (!walletApi || !identifier) return;
    setIsLoading(true);
    setError(null);

    try {
      await walletApi.requestCode(identifier, identifierType);
      setStep('verify');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('wallet.dhiway_error_send_code'));
    } finally {
      setIsLoading(false);
    }
  };

  const verifyCode = async () => {
    if (!walletApi || !identifier || !verificationCode.trim()) return;
    setIsLoading(true);
    setError(null);

    try {
      const response = await walletApi.verifyCode(identifier, verificationCode.trim());
      if (response.token) {
        walletApi.setAuthToken(response.token);
      }
      const credentials = await walletApi.getVerifiedCredentials(identifier);
      setCredentialGroups(credentials.credentials);
      setStep('credentials');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('wallet.dhiway_error_verify_code'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleImport = (credentialData: WalletCredentialData, credential: WalletCredential) => {
    if (!walletApi) return;
    const result = walletApi.transformSelectedCredential(credentialData, credential);
    onSuccess({
      data: result.data,
      candidates: result.candidates,
      rawPayload: result.rawPayload,
      metadata: result.metadata,
      providerName: 'dhiway-wallet',
      providerLabel: 'Dhiway Wallet',
      summary: result.summary,
    });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/30 p-4">
        <div className="flex items-center gap-3">
          <div className="rounded-full bg-primary/10 p-2 text-primary">
            <Wallet className="h-5 w-5" />
          </div>
          <div>
            <p className="font-medium">{t('wallet.dhiway_title')}</p>
            <p className="text-sm text-muted-foreground">
              {t('wallet.dhiway_subtitle')}
            </p>
          </div>
        </div>
      </div>

      {step === 'identifier' && (
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('wallet.dhiway_choose_identifier')}</p>
            {identifierOptions.length > 1 ? (
              <Select
                value={identifier}
                onValueChange={(value) => {
                  const selected = identifierOptions.find((option) => option.value === value);
                  setIdentifier(value);
                  if (selected) setIdentifierType(selected.type);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('wallet.dhiway_select_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  {identifierOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="rounded-md border px-3 py-2 text-sm">
                {identifier || t('wallet.dhiway_no_identifier')}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {identifierType === 'email' ? <Mail className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
            {t('wallet.dhiway_code_hint', { identifierType })}
          </div>
        </div>
      )}

      {step === 'verify' && (
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('wallet.dhiway_enter_code')}</p>
            <Input
              value={verificationCode}
              onChange={(event) => setVerificationCode(event.target.value)}
              placeholder={t('wallet.dhiway_code_placeholder')}
            />
          </div>
          <Button variant="outline" onClick={() => setStep('identifier')}>
            {t('wallet.dhiway_change_identifier')}
          </Button>
        </div>
      )}

      {step === 'credentials' && (
        <div className="max-h-[52dvh] space-y-3 overflow-y-auto pr-1">
          {credentialGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('wallet.dhiway_no_credentials')}</p>
          ) : (
            credentialGroups.map((credentialData) => (
                <Card key={credentialData.id} className="gap-4 py-4">
                  <CardHeader className="px-4">
                  <CardTitle className="text-base">
                    {getProviderLabel(credentialData.metadata?.orgName, t('wallet.dhiway_fallback_issuer'))}
                  </CardTitle>
                  <CardDescription>
                    {getProviderLabel(credentialData.metadata?.issuedBy, t('wallet.dhiway_fallback_issued_by'))}
                  </CardDescription>
                  </CardHeader>
                <CardContent className="space-y-3 px-4">
                  {credentialData.credentials.map((credential) => (
                    <div key={credential.id} className="rounded-lg border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-medium">{getSchemaTitle(credential, t('wallet.dhiway_credential'))}</p>
                          {credential.issuanceDate ? (
                            <p className="text-xs text-muted-foreground">
                              {t('wallet.dhiway_issued_on', { date: new Date(credential.issuanceDate).toLocaleDateString() })}
                            </p>
                          ) : null}
                        </div>
                        <Badge variant="secondary">{t('wallet.dhiway_verified_badge')}</Badge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {getPreviewFields(credential.credentialSubject).map((field) => (
                          <span key={`${credential.id}-${field}`}>{field}</span>
                        ))}
                      </div>
                      <Button className="mt-3" size="sm" onClick={() => handleImport(credentialData, credential)}>
                        {t('wallet.dhiway_import_btn')}
                      </Button>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex justify-between gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        {step === 'identifier' ? (
          <Button onClick={requestCode} disabled={!identifier || isLoading}>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {t('wallet.dhiway_send_code')}
          </Button>
        ) : step === 'verify' ? (
          <Button onClick={verifyCode} disabled={!verificationCode.trim() || isLoading}>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('wallet.dhiway_verify_fetch')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const provider: WalletProvider = {
  name: 'dhiway-wallet',
  label: 'Dhiway Wallet',
  description: 'Import verified credentials using email or phone verification.',
  component: DhiwayWalletProvider,
  isConfigured: isWalletConfigured,
  getConfigurationHint: () => 'Missing VITE_VC_WALLET_URL or VITE_VC_WALLET_API_KEY.',
};

registerWalletProvider(provider);
