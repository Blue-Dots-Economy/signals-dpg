import { MapPin, Navigation } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { PreferredLocationSource } from '@/hooks/use-user-location';

export interface LocationSourceToggleProps {
  value: PreferredLocationSource;
  onChange: (value: PreferredLocationSource) => void;
}

/**
 * Switches the "nearby" anchor between the active profile's location and the
 * browser's current location. Render only when a profile location exists and
 * geolocation is supported (the caller owns that visibility rule).
 */
export function LocationSourceToggle({ value, onChange }: LocationSourceToggleProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-sm text-muted-foreground sm:inline">
        {t('home.search_near_label')}
      </span>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(next) => {
          if (next === 'profile' || next === 'browser') onChange(next);
        }}
        variant="outline"
        size="sm"
      >
        <ToggleGroupItem value="profile" aria-label={t('home.search_near_profile')}>
          <MapPin className="mr-1.5 h-4 w-4" />
          <span className="hidden sm:inline">{t('home.search_near_profile')}</span>
        </ToggleGroupItem>
        <ToggleGroupItem value="browser" aria-label={t('home.search_near_browser')}>
          <Navigation className="mr-1.5 h-4 w-4" />
          <span className="hidden sm:inline">{t('home.search_near_browser')}</span>
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
