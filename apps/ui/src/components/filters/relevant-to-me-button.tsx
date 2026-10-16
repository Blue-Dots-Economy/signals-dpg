import { useTranslation } from 'react-i18next';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

export interface RelevantToMeButtonProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  // False when more than one domain is browsed at once — see home-page.tsx's relevantToMeSingleDomainOk.
  singleDomainOk: boolean;
}

export function RelevantToMeButton({
  enabled,
  onChange,
  singleDomainOk,
}: Readonly<RelevantToMeButtonProps>) {
  const { t } = useTranslation();
  const label = t('filters.relevant_to_me.label');
  const title = singleDomainOk
    ? t('filters.relevant_to_me.description')
    : t('filters.relevant_to_me.needs_single_domain');
  return (
    <label
      title={title}
      className={cn(
        'flex h-auto items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-semibold shadow-none',
        'pointer-coarse:min-h-11',
        singleDomainOk ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
        enabled && singleDomainOk && 'border-primary/50 bg-primary/5 text-primary',
      )}
    >
      <span className="hidden sm:inline">{label}</span>
      <Switch
        checked={enabled}
        onCheckedChange={onChange}
        disabled={!singleDomainOk}
        aria-label={label}
      />
    </label>
  );
}
