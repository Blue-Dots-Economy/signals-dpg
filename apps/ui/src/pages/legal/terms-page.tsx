import { useConsentConfig } from '@/hooks/use-consent-config';
import { Markdown } from '@/components/consent/markdown';
import { Loader2 } from 'lucide-react';

export function TermsPage() {
  const { config, isLoading } = useConsentConfig();

  if (isLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const doc = config?.documents.terms;
  const version = doc?.versions.find((v) => v.version === doc.current_version);

  if (!version) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <p className="text-sm text-muted-foreground">Terms of service unavailable.</p>
      </div>
    );
  }

  return (
    <div className="min-h-svh bg-background px-6 py-12">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-bold text-foreground mb-6">{version.title}</h1>
        <Markdown>{version.content}</Markdown>
      </div>
    </div>
  );
}
