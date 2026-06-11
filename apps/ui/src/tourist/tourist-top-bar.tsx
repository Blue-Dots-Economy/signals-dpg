import { Search, List, MapPinned } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { ThemeModeToggle } from '@/components/layout/theme-mode-toggle';
import type { ViewMode } from '@/engine/types';
import type { ReactNode } from 'react';

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
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-gradient-to-r from-background to-primary/5 px-4 sm:px-6">
      <div className="relative flex-1 max-w-md">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          type="search"
          placeholder={t('common.search')}
          className="pl-8"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
      {filtersSlot}
      <div className="ml-auto flex items-center gap-2">
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
    </header>
  );
}
