import type { ConsentConfigDocument } from '@dpg/schemas';
import {
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Markdown } from '@/components/consent/markdown';
import { ConsentGateBody, type ConsentGateDoc } from '@/components/consent/consent-gate';
import { useNetworkTheme } from '@/theme/theme-provider';
import { useTranslation } from 'react-i18next';

export type ConsentModalMode = 'gate' | 'view';
export type ConsentModalTab = 'privacy' | 'terms';

export interface ConsentModalProps {
  open: boolean;
  mode: ConsentModalMode;
  initialTab: ConsentModalTab;
  config: ConsentConfigDocument;
  /**
   * Which document set to show. 'u18' renders the minor/guardian copy
   * (`u18_documents`) so a guardian sees the U18 terms/privacy, not the adult
   * ones. Falls back to the adult `documents` when a U18 set isn't configured.
   */
  variant?: 'adult' | 'u18';
  onAccept?: () => void;
  onOpenChange?: (open: boolean) => void;
}

function getCurrentVersion(doc: ConsentConfigDocument['documents']['terms'] | ConsentConfigDocument['documents']['privacy']) {
  return doc.versions.find((v) => v.version === doc.current_version);
}

export function ConsentModal({
  open,
  mode,
  initialTab,
  config,
  variant = 'adult',
  onAccept,
  onOpenChange,
}: ConsentModalProps) {
  const { theme } = useNetworkTheme();
  const { t } = useTranslation();

  const docs = variant === 'u18' && config.u18_documents ? config.u18_documents : config.documents;
  const privacyVersion = getCurrentVersion(docs.privacy);
  const termsVersion = getCurrentVersion(docs.terms);

  const gateDocs: ConsentGateDoc[] = [
    privacyVersion && {
      id: 'privacy',
      cap: t('consent.tab_privacy'),
      title: privacyVersion.title,
      body: privacyVersion.content,
    },
    termsVersion && {
      id: 'terms',
      cap: t('consent.tab_terms'),
      title: termsVersion.title,
      body: termsVersion.content,
    },
  ].filter((doc): doc is ConsentGateDoc => Boolean(doc));

  const handleOpenChange = (nextOpen: boolean) => {
    if (mode === 'gate') return;
    onOpenChange?.(nextOpen);
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={handleOpenChange}
      showCloseButton={mode === 'view'}
      dismissible={mode !== 'gate'}
      title={mode === 'gate' ? t('consent.title_gate') : t('consent.title_view')}
      contentClassName="flex flex-col max-w-2xl max-h-[90dvh] gap-0 p-0 overflow-hidden"
      onInteractOutside={(e) => {
        if (mode === 'gate') e.preventDefault();
      }}
      onEscapeKeyDown={(e) => {
        if (mode === 'gate') e.preventDefault();
      }}
    >
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0 text-left">
          {theme?.name && (
            <p className="text-xs font-bold uppercase tracking-wide text-primary">
              {theme.name}
            </p>
          )}
          <DialogTitle className="text-xl font-bold">
            {mode === 'gate' ? t('consent.title_gate') : t('consent.title_view')}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {mode === 'gate' ? t('consent.desc_gate') : t('consent.desc_view')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col flex-1 overflow-hidden px-6 pb-4 gap-4">
          {mode === 'gate' ? (
            <ConsentGateBody docs={gateDocs} onAccept={() => onAccept?.()} />
          ) : (
            <Tabs defaultValue={initialTab} className="flex flex-col flex-1 overflow-hidden">
              <TabsList className="w-full shrink-0 h-11 p-1">
                <TabsTrigger
                  value="privacy"
                  className="flex-1 data-[state=active]:text-primary data-[state=active]:font-semibold"
                >
                  {t('consent.tab_privacy')}
                </TabsTrigger>
                <TabsTrigger
                  value="terms"
                  className="flex-1 data-[state=active]:text-primary data-[state=active]:font-semibold"
                >
                  {t('consent.tab_terms')}
                </TabsTrigger>
              </TabsList>

              <TabsContent
                value="privacy"
                className="flex-1 overflow-y-auto mt-4 pr-1"
              >
                {privacyVersion && <Markdown>{privacyVersion.content}</Markdown>}
              </TabsContent>

              <TabsContent
                value="terms"
                className="flex-1 overflow-y-auto mt-4 pr-1"
              >
                {termsVersion && <Markdown>{termsVersion.content}</Markdown>}
              </TabsContent>
            </Tabs>
          )}
        </div>
    </ResponsiveDialog>
  );
}
