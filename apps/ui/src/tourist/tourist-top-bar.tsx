import { Search, List, MapPinned } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { ThemeModeToggle } from '@/components/layout/theme-mode-toggle';
import { brandLogoUrl, networkLogoUrl } from '@/theme/brand-assets';
import { useThemeMode } from '@/theme/mode-provider';
import type { ViewMode } from '@/engine/types';
import type { ReactNode } from 'react';
import { TOURIST_NETWORK_ID, TOURIST_BRAND } from './resolve-tourist-config';

export interface TouristTopBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  filtersSlot?: ReactNode;
}

export function TouristTopBar({
  search,
  onSearchChange,
  viewMode,
  onViewModeChange,
  filtersSlot,
}: TouristTopBarProps) {
  const { t } = useTranslation();
  const { resolved } = useThemeMode();
  // Light logo for dark backgrounds, default logo otherwise (mirrors PortalHeader).
  const variant = resolved === 'dark' ? 'light' : 'default';
  const logoSrc = brandLogoUrl(TOURIST_NETWORK_ID, variant, TOURIST_BRAND);

  return (
    <header className="sticky top-0 z-40 border-b bg-gradient-to-r from-background to-primary/5 px-3 py-2 sm:px-6 sm:py-0">
      {/* Mobile: two rows; logo, filters and controls, then a full-width
          search as a separate flex-col child, so it can never be squeezed
          onto the first row. Desktop (sm+): the inner wrapper is
          `display:contents`, so everything joins one 56px row ordered by
          sm:order-* (logo → search → filters → controls). */}
      <div className="flex flex-col gap-2 sm:h-14 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex items-center gap-2 sm:contents">
          {logoSrc && (
            <img
              src={logoSrc}
              alt={t('nav.portal_logo_alt', { name: TOURIST_NETWORK_ID })}
              // Smaller on mobile; on desktop matches the tourist network sidebar size.
              className="h-8 w-auto max-w-[120px] shrink-0 object-contain sm:order-1 sm:h-12 sm:max-w-[200px]"
              onError={(e) => {
                const fb = networkLogoUrl(TOURIST_NETWORK_ID, variant);
                if (fb && e.currentTarget.src.endsWith(fb) === false) e.currentTarget.src = fb;
              }}
            />
          )}
          <div className="flex items-center sm:order-3">{filtersSlot}</div>
          <div className="ml-auto flex items-center gap-1 sm:order-4 sm:gap-2">
            <ToggleGroup
              type="single"
              value={viewMode}
              onValueChange={(value) => {
                if (value) onViewModeChange(value as ViewMode);
              }}
            >
              <ToggleGroupItem value="map" aria-label={t('nav.map_view')}>
                <MapPinned className="h-4 w-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label={t('nav.list_view')}>
                <List className="h-4 w-4" />
              </ToggleGroupItem>
            </ToggleGroup>
            <LanguageSwitcher compact />
            <ThemeModeToggle />
          </div>
        </div>
        {/* Search: its own full-width row on mobile; on desktop it sits second
            (sm:order-2, between logo and filters) and grows. */}
        <div className="relative w-full min-w-0 sm:order-2 sm:ml-10 sm:w-auto sm:max-w-md sm:flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder={t('common.search')}
            className="pl-8"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      </div>
    </header>
  );
}
