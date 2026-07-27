import * as React from 'react';
import { ChevronLeft, PlugZap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  getConfiguredWalletProviders,
  getRegisteredWalletProviders,
  getWalletProvider,
} from '@/engine/wallet/wallet-registry';
import type { WalletImportContext, WalletImportResult } from '@/engine/wallet/types';

interface WalletImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: WalletImportContext;
  onImported: (result: WalletImportResult) => void;
}

export function WalletImportModal({ open, onOpenChange, context, onImported }: WalletImportModalProps) {
  const { t } = useTranslation();
  const providers = React.useMemo(() => getRegisteredWalletProviders(), [open]);
  const configuredProviders = React.useMemo(() => getConfiguredWalletProviders(), [open]);
  const [selectedProviderName, setSelectedProviderName] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setSelectedProviderName(null);
    }
  }, [open]);

  const selectedProvider = selectedProviderName ? getWalletProvider(selectedProviderName) : undefined;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('wallet.import_title')}
      contentClassName="max-h-[85dvh] max-w-2xl overflow-hidden p-0 sm:max-h-[90dvh]"
    >
        <div className="flex max-h-[85dvh] flex-col sm:max-h-[90dvh]">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle>{t('wallet.import_title')}</DialogTitle>
            <DialogDescription>
              {t('wallet.import_subtitle')}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {!selectedProvider ? (
              <div className="space-y-4">
                {providers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('wallet.none_registered')}</p>
                ) : (
                  providers.map((provider) => {
                    const configured = provider.isConfigured();
                    return (
                      <Card key={provider.name} className="gap-4 py-4">
                        <CardHeader className="px-4">
                          <CardTitle className="flex items-center gap-2 text-base">
                            <PlugZap className="h-4 w-4" />
                            {provider.label}
                          </CardTitle>
                          <CardDescription>{provider.description}</CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col items-start justify-between gap-4 px-4 sm:flex-row sm:items-center">
                          <p className="text-xs text-muted-foreground">
                            {configured
                              ? t('wallet.ready_to_import')
                              : provider.getConfigurationHint?.() ?? t('wallet.not_configured')}
                          </p>
                          <Button disabled={!configured} onClick={() => setSelectedProviderName(provider.name)}>
                            {t('wallet.use_provider', { provider: provider.label })}
                          </Button>
                        </CardContent>
                      </Card>
                    );
                  })
                )}

                {configuredProviders.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t('wallet.configure_at_least_one')}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-4">
                <Button variant="ghost" className="w-fit" onClick={() => setSelectedProviderName(null)}>
                  <ChevronLeft className="h-4 w-4" />
                  {t('wallet.back_to_providers')}
                </Button>
                <selectedProvider.component
                  context={context}
                  onCancel={() => onOpenChange(false)}
                  onSuccess={(result) => {
                    onImported(result);
                    onOpenChange(false);
                  }}
                />
              </div>
            )}
          </div>
        </div>
    </ResponsiveDialog>
  );
}
