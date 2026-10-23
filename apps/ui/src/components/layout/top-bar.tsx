import { useNavigate } from 'react-router-dom';
import { Search, List, MapPinned, LogIn, Bell, ArrowLeft } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import { GuideButton } from '@/guide/guide-button';
import type { ViewMode } from '@/engine/types';

interface TopBarProps {
  /** 'browse' (default) shows search/filters/view-toggle; 'form' shows a Back button + title instead. */
  variant?: 'browse' | 'form';
  /** Shown next to the Back button when `variant === 'form'`. */
  title?: string;
  /** Optional secondary line under `title` when `variant === 'form'`. */
  subtitle?: string;
  /** Invoked by the Back button when `variant === 'form'`. */
  onBack?: () => void;
  /** Label for the Back control (default "Back"). */
  backLabel?: string;
  // browse only
  search?: string;
  onSearchChange?: (value: string) => void;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
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
      data-tour="notifications"
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
  variant = 'browse',
  title,
  subtitle,
  onBack,
  backLabel,
  search,
  onSearchChange,
  viewMode,
  onViewModeChange,
}: Readonly<TopBarProps>) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { isAuthenticated, isLoading } = useAuth();

  return (
    <header className="sticky top-0 z-40 flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-gradient-to-r from-background to-primary/5 px-4 py-2 sm:flex-nowrap sm:py-0 sm:px-6">
      <SidebarTrigger className="md:hidden" />
      {variant === 'form' ? (
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onBack}
            className="gap-1.5"
            aria-label={backLabel ?? t('common.back')}
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">{backLabel ?? t('common.back')}</span>
          </Button>
          {title && (
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-foreground sm:text-[15px]">{title}</h1>
              {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Search shares row one on mobile when there is room. */}
          {/* Wide (`max-w-2xl`): the Filters trigger is in the toolbar. */}
          <div
            className={cn(
              'relative min-w-0 sm:order-none sm:w-auto sm:flex-1 sm:max-w-2xl',
              // Signed in, language and theme are hidden under `md`, so search
              // fits inline. Signed out it takes its own full-width line rather
              // than shrinking to a stub.
              isAuthenticated ? 'flex-1' : 'order-last w-full',
            )}
          >
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              data-tour="search"
              type="search"
              aria-label={t('common.search')}
              placeholder={t('common.search')}
              className="pl-8"
              value={search ?? ''}
              onChange={(e) => onSearchChange?.(e.target.value)}
            />
          </div>
        </>
      )}
      <div className="ml-auto flex items-center gap-2">
        {variant === 'browse' && (
          <ToggleGroup
            data-tour="view-toggle"
            type="single"
            value={viewMode}
            onValueChange={(value) => {
              if (value) onViewModeChange?.(value as ViewMode);
            }}
          >
            <ToggleGroupItem data-tour="view-map" value="map" aria-label={t('nav.map_view')}>
              <MapPinned className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem data-tour="view-list" value="list" aria-label={t('nav.list_view')}>
              <List className="h-4 w-4" />
            </ToggleGroupItem>
          </ToggleGroup>
        )}

        {/* On mobile, signed-in users get these in the avatar menu instead. */}
        <div
          data-tour="preferences"
          className={cn('flex items-center gap-2', isAuthenticated && 'hidden md:flex')}
        >
          {/* `compact`: icon-only below sm, so the signed-out mobile bar does
              not overflow. */}
          <LanguageSwitcher compact />
          <ThemeModeToggle />
        </div>

        <GuideButton />

        {!isLoading && (
          isAuthenticated ? (
            <>
              <span className="hidden md:inline-flex">
                <NotificationBell />
              </span>
              <span data-tour="account" className="inline-flex">
                <UserMenu />
              </span>
            </>
          ) : (
            <Button
              data-tour="account"
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
