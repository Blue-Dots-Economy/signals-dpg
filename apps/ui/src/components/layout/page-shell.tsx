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
  /**
   * Sidebar Browse group. Optional: the browse page selects domains in its
   * toolbar and passes `hideBrowse` instead.
   */
  domains?: DotNetworkDomain[];
  selectedDomain?: string | null;
  onDomainSelect?: (domainId: string | null) => void;
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
  /**
   * Browse state bar, rendered between the top bar and `<main>` as a sibling.
   * `<main>` is the scroll container, so this is pinned without `sticky`; a
   * sticky child would need an offset equal to the wrapping top bar's
   * variable height.
   */
  toolbarSlot?: React.ReactNode;
  /** Label for the form-variant Back control (defaults to "Back" in TopBar). */
  backLabel?: string;
  /** Hide the sidebar's Browse (domain selector) group. */
  hideBrowse?: boolean;
  /** A footer pinned below the scroll area, e.g. the form action bar. A
   * `sticky` element inside `<main>` would float on short content. */
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
  toolbarSlot,
  backLabel,
  hideBrowse,
  footerSlot,
}: Readonly<PageShellProps>) {
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
          domains={domains ?? []}
          selectedDomain={selectedDomain ?? null}
          onDomainSelect={onDomainSelect ?? (() => {})}
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
          />
          {toolbarSlot && (
            // `flex-none` keeps its natural height in the flex column.
            <div className="flex-none border-b bg-background">{toolbarSlot}</div>
          )}
          <main
            id="main-content"
            // `min-h-0` lets this flex child shrink, so a tall form scrolls
            // inside <main> instead of growing the body. `relative` makes <main>
            // the containing block for absolutely positioned descendants (e.g.
            // cmdk's hidden labels); otherwise they stretch the document and
            // add a second body scrollbar.
            className="relative min-h-0 flex-1 overflow-y-auto p-4 max-md:overflow-x-clip sm:p-6"
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
