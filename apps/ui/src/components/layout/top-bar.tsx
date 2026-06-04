import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, List, MapPinned, LogIn, Bell } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { UserMenu } from '@/components/auth/user-menu';
import { ThemeModeToggle } from '@/components/layout/theme-mode-toggle';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { useAuth } from '@/contexts/auth-context';
import { usePendingActionsCount } from '@/hooks/use-actions';
import type { ViewMode } from '@/engine/types';

interface TopBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  /** Optional Filters control rendered next to the search bar (home/browse only). */
  filtersSlot?: React.ReactNode;
}

function NotificationBell() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { data: count = 0 } = usePendingActionsCount();

  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative"
      onClick={() => navigate('/my-actions')}
      aria-label={t('nav.pending_actions', { count })}
    >
      <Bell className="h-4 w-4" />
      {count > 0 && (
        <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </Button>
  );
}

export function TopBar({
  search,
  onSearchChange,
  viewMode,
  onViewModeChange,
  filtersSlot,
}: TopBarProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { isAuthenticated, isLoading } = useAuth();

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-gradient-to-r from-background to-primary/5 px-4 sm:px-6">
      <SidebarTrigger className="md:hidden" />
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
      {/* Filters control sits immediately to the right of the search bar. */}
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

        {!isLoading && (
          isAuthenticated ? (
            <>
              <NotificationBell />
              <UserMenu />
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/auth/login')}
              className="gap-2"
            >
              <LogIn className="h-4 w-4" />
              <span className="hidden sm:inline">{t('common.login')}</span>
            </Button>
          )
        )}
      </div>
    </header>
  );
}
