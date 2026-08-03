import type { RJSFSchema } from '@rjsf/utils';
import { useTranslation } from 'react-i18next';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { DotNetworkDomain, DotNetworkSchema, ViewMode } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import { TopBar } from './top-bar';
import { AppSidebar } from './sidebar';

interface PageShellProps {
  children: React.ReactNode;
  /** 'browse' (default) shows search/filters/view-toggle; 'form' shows a Back button + title instead. Forwarded to `TopBar`. */
  variant?: 'browse' | 'form';
  /** Shown next to the Back button when `variant === 'form'`. */
  title?: string;
  /** Optional secondary line under `title` when `variant === 'form'`. */
  subtitle?: string;
  /** Invoked by the Back button when `variant === 'form'`. */
  onBack?: () => void;
  networks?: DotNetworkSchema[];
  selectedNetwork?: string | null;
  onNetworkSelect?: (networkId: string) => void;
  domains: DotNetworkDomain[];
  selectedDomain: string | null;
  onDomainSelect: (domainId: string | null) => void;
  currentDomainLabel?: string;
  myItems?: Item[];
  activeProfileId?: string | null;
  onActiveProfileChange?: (profileId: string) => void;
  onProfilesChanged?: () => void;
  userSchemas?: Record<string, RJSFSchema>;
  search?: string;
  onSearchChange?: (value: string) => void;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  /** Optional Filters control surfaced in the top bar next to the search input. */
  filtersSlot?: React.ReactNode;
  /** Label for the form-variant Back control (defaults to "Back" in TopBar). */
  backLabel?: string;
  /** Hide the sidebar's Browse (domain selector) group — form pages. */
  hideBrowse?: boolean;
  /** A pinned footer rendered BELOW the scroll area (not inside it). Used by the
   * form pages for the action bar so it stays fixed at the column bottom while
   * the form scrolls above it — a `sticky` element inside `<main>` floats when
   * the content is shorter than the viewport, which this avoids. */
  footerSlot?: React.ReactNode;
}

export function PageShell({
  children,
  variant,
  title,
  subtitle,
  onBack,
  networks,
  selectedNetwork,
  onNetworkSelect,
  domains,
  selectedDomain,
  onDomainSelect,
  currentDomainLabel,
  myItems,
  activeProfileId,
  onActiveProfileChange,
  onProfilesChanged,
  userSchemas,
  search,
  onSearchChange,
  viewMode,
  onViewModeChange,
  filtersSlot,
  backLabel,
  hideBrowse,
  footerSlot,
}: PageShellProps) {
  const { t } = useTranslation();
  return (
    <TooltipProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:shadow"
      >
        {t('a11y.skip_to_content')}
      </a>
      <SidebarProvider>
        <AppSidebar
          networks={networks}
          selectedNetwork={selectedNetwork}
          onNetworkSelect={onNetworkSelect}
          domains={domains}
          selectedDomain={selectedDomain}
          onDomainSelect={onDomainSelect}
          currentDomainLabel={currentDomainLabel}
          myItems={myItems}
          activeProfileId={activeProfileId}
          onActiveProfileChange={onActiveProfileChange}
          onProfilesChanged={onProfilesChanged}
          userSchemas={userSchemas}
          hideBrowse={hideBrowse}
        />
        <div className="flex h-svh min-w-0 flex-1 flex-col">
          <TopBar
            variant={variant}
            title={title}
            subtitle={subtitle}
            onBack={onBack}
            backLabel={backLabel}
            search={search}
            onSearchChange={onSearchChange}
            viewMode={viewMode}
            onViewModeChange={onViewModeChange}
            filtersSlot={filtersSlot}
          />
          <main
            id="main-content"
            className="flex-1 overflow-y-auto p-4 max-md:overflow-x-clip sm:p-6"
          >
            {children}
          </main>
          {footerSlot && (
            <div className="flex-none border-t bg-background">{footerSlot}</div>
          )}
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}
