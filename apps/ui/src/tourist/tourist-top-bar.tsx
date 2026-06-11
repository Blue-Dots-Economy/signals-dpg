import { Search, List, MapPinned } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { ThemeModeToggle } from '@/components/layout/theme-mode-toggle';
import { brandLogoUrl } from '@/theme/brand-assets';
import { useThemeMode } from '@/theme/mode-provider';
import type { ViewMode } from '@/engine/types';
import type { ReactNode } from 'react';

/** The tourist app serves the orange_dot network exclusively. */
const TOURIST_NETWORK_ID = 'orange_dot';

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
  const logoSrc = brandLogoUrl(TOURIST_NETWORK_ID, resolved === 'dark' ? 'light' : 'default');

  return (
    // Mobile (base): wraps to two rows — logo + filters + controls on top,
    // full-width search below. Desktop (sm+): a single fixed-height row,
    // identical to before (logo → search → filters → controls), restored via
    // the sm:order / sm:width classes on each child.
    <header className="sticky top-0 z-40 flex flex-wrap items-center gap-2 border-b bg-gradient-to-r from-background to-primary/5 px-3 py-2 sm:h-14 sm:flex-nowrap sm:gap-3 sm:px-6 sm:py-0">
      {logoSrc && (
        <img
          src={logoSrc}
          alt={t('nav.portal_logo_alt', { name: 'orange dots AI' })}
          // Smaller on mobile; on desktop matches the orange_dot sidebar size
          // (square-ish ~1.78:1 mark, so a taller box than wordmark brands).
          className="h-8 w-auto max-w-[120px] shrink-0 object-contain sm:order-1 sm:h-12 sm:max-w-[200px]"
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
        <LanguageSwitcher />
        <ThemeModeToggle />
      </div>
      {/* Search: full-width second row on mobile (order-last); on desktop it
          sits second (sm:order-2) and grows like before. */}
      <div className="relative order-last w-full min-w-0 sm:order-2 sm:ml-10 sm:w-auto sm:max-w-md sm:flex-1">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          type="search"
          placeholder={t('common.search')}
          className="pl-8"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
    </header>
  );
}
