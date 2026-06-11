import { MapPin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export interface EnableLocationBannerProps {
  onEnable: () => void;
}

/** Shown when geolocation is denied/unavailable: all practitioners are shown; offer to enable. */
export function EnableLocationBanner({ onEnable }: EnableLocationBannerProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/50 px-4 py-2 text-sm">
      <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{t('tourist.enable_location_title')}</span>{' '}
        <span className="text-muted-foreground">{t('tourist.enable_location_body')}</span>
      </div>
      <Button size="sm" variant="outline" className="shrink-0" onClick={onEnable}>
        {t('tourist.enable_location_cta')}
      </Button>
    </div>
  );
}
