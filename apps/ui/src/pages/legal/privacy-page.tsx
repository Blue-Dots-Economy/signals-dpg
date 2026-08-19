import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { ThemeModeToggle } from '@/components/layout/theme-mode-toggle';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { Markdown } from '@/components/consent/markdown';
import { Loader2 } from 'lucide-react';

export function PrivacyPage() {
  const { config, isLoading } = useConsentConfig();

  if (isLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const doc = config?.documents.privacy;
  const version = doc?.versions.find((v) => v.version === doc.current_version);

  if (!version) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <p className="text-sm text-muted-foreground">Privacy policy unavailable.</p>
      </div>
    );
  }

  return (
    <div className="min-h-svh bg-background px-6 py-12">
      <div className="mx-auto max-w-2xl">
        {/* Same language + theme controls the app's top bar carries. These
            pages are reachable straight from the auth footer, so a visitor can
            land here before ever seeing the top bar. */}
        <TooltipProvider>
          <div className="mb-4 flex items-center justify-end gap-1">
            <LanguageSwitcher compact />
            <ThemeModeToggle />
          </div>
        </TooltipProvider>
        <h1 className="text-2xl font-bold text-foreground mb-6">{version.title}</h1>
        <Markdown>{version.content}</Markdown>
      </div>
    </div>
  );
}
