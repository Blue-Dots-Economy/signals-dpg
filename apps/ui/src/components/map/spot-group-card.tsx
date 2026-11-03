import { useTranslation } from 'react-i18next';
import { List, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { OpenSpotGroup } from '@/engine/types';
import { formatDomainLabel } from '@/lib/domain-icons';
import { getIconForDomain } from './domain-icons';

interface SpotGroupCardProps {
  group: OpenSpotGroup;
  formatDomain?: (domain: string) => string;
  onView?: (group: OpenSpotGroup) => void;
  onClose?: () => void;
}

/** Explains a bubble that cannot split and offers its listings in the list. */
export function SpotGroupCard({ group, formatDomain = formatDomainLabel, onView, onClose }: SpotGroupCardProps) {
  const { t } = useTranslation();
  const n = group.count.toLocaleString();
  return (
    <div className="relative w-[min(340px,calc(100vw-2rem))] space-y-3 p-1 text-sm" data-testid="spot-group-card">
      {onClose && (
        <button
          type="button"
          aria-label={t('map.spot_close')}
          onClick={onClose}
          className="absolute right-0 top-0 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent pointer-coarse:h-11 pointer-coarse:w-11"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
      <p className="pr-9 text-base font-semibold leading-snug">
        {t(group.exact ? 'map.spot_title_exact' : 'map.spot_title_near', { n })}
      </p>
      <p className="text-muted-foreground">{t(group.exact ? 'map.spot_body_exact' : 'map.spot_body_near')}</p>
      <div className="flex flex-wrap gap-1.5">
        {group.breakdown.map((b) => {
          const Icon = getIconForDomain(b.domain);
          return (
            <span
              key={b.domain}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium"
            >
              <Icon className="h-3 w-3 text-primary" aria-hidden />
              {t('map.spot_type_count', { n: b.count.toLocaleString(), type: formatDomain(b.domain) })}
            </span>
          );
        })}
      </div>
      {onView && (
        <Button type="button" className="w-full pointer-coarse:min-h-11" onClick={() => onView(group)}>
          <List className="h-4 w-4" aria-hidden />
          {t('map.spot_view_in_list', { n })}
        </Button>
      )}
    </div>
  );
}
