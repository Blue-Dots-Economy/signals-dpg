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
            className="underline underline-offset-2 hover:text-foreground"
          >
            Privacy Policy
          </button>{' '}
          and{' '}
          <button
            type="button"
            onClick={() => openModal('terms')}
            className="underline underline-offset-2 hover:text-foreground"
          >
            Terms
          </button>
          .
        </p>
        <div className="flex items-center justify-between">
          <span>{theme.inviteLine}</span>
          <a href="mailto:support@onest.network" className="hover:text-foreground hover:underline">
            Need help?
          </a>
        </div>
      </footer>
    </>
  );
}
