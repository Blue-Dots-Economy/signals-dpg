import { useState } from 'react';
import { useNetworkTheme } from '@/theme/theme-provider';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { ConsentModal } from '@/components/consent/consent-modal';
import type { ConsentModalTab } from '@/components/consent/consent-modal';

export function AuthFooter() {
  const { theme } = useNetworkTheme();
  const { config } = useConsentConfig();
  const [modalTab, setModalTab] = useState<ConsentModalTab | null>(null);

  const openModal = (tab: ConsentModalTab) => {
    if (!config) return;
    setModalTab(tab);
  };

  return (
    <>
      {config && modalTab && (
        <ConsentModal
          open={true}
          mode="view"
          initialTab={modalTab}
          config={config}
          onOpenChange={(open) => { if (!open) setModalTab(null); }}
        />
      )}
      <footer className="px-6 pb-6 pt-4 sm:px-10 lg:px-14 text-xs text-muted-foreground">
        <p className="mb-3">
          By continuing you agree to the{' '}
          <button
            type="button"
            onClick={() => openModal('privacy')}
            className="text-primary font-medium underline underline-offset-2 hover:opacity-80"
          >
            Privacy Policy
          </button>{' '}
          and{' '}
          <button
            type="button"
            onClick={() => openModal('terms')}
            className="text-primary font-medium underline underline-offset-2 hover:opacity-80"
          >
            Terms
          </button>
          .
        </p>
        <div className="flex items-center">
          <span>{theme.inviteLine}</span>
        </div>
      </footer>
    </>
  );
}
