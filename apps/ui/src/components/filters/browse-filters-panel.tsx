import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { DrawerTitle } from '@/components/ui/drawer';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import type { DotNetworkDomain, ViewMode } from '@/engine/types';
import { getEnumFilterFieldsForDomains } from '@/lib/enum-filters';
import type { EnumFilterField } from '@/lib/enum-filters';
import { MultiSelectGroup, CHIP_THRESHOLD } from '@/components/filters/multi-select-group';

/**
 * The facet editor for both browse views. The applied-filter chips are the
 * read-out; only the caller owns the state.
 */
export interface BrowseFiltersPanelProps {
  /** All visible domains (from the network config) to show as filter options. */
  domains: DotNetworkDomain[];
  /**
   * Domains whose schema fields drive the enum filter groups. Defaults to
   * `domains`. Supplied separately so the enum filters can reflect the
   * counterpart being selected (e.g. a provider browsing seekers filters by
   * seeker fields) while the domain chip selector still lists every visible
   * domain.
   */
  filterFieldDomains?: DotNetworkDomain[];
  /** Selected values per enum field key. A missing or empty entry means all. */
  selectedFields: Record<string, string[]>;
  onFieldsChange: (fields: Record<string, string[]>) => void;
  /** Current browse view — tailors the help text (map markers vs listings). */
  viewMode?: ViewMode;
  /**
   * Where the trigger is mounted. `'toolbar'` matches the Sort and Location
   * pills beside it; `'overlay'` is the raised, blurred chip for floating over
   * map tiles.
   */
  trigger?: 'toolbar' | 'overlay';
}

interface ChipProps {
  label: string;
  selected: boolean;
  onToggle: () => void;
  title?: string;
  ariaLabel?: string;
}

function Chip({ label, selected, onToggle, title, ariaLabel }: Readonly<ChipProps>) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      aria-label={ariaLabel ?? label}
      aria-pressed={selected}
      className={cn(
        'inline-flex cursor-pointer items-center rounded-full border px-2.5 py-1 text-xs font-medium leading-none transition-all duration-150',
        'pointer-coarse:min-h-11',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        selected
          ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border-border bg-muted text-muted-foreground hover:border-primary/40 hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {label}
    </button>
  );
}

interface FilterGroupProps {
  title: string;
  children: React.ReactNode;
}

function FilterGroup({ title, children }: Readonly<FilterGroupProps>) {
  return (
    <div className="space-y-2">
      <span className="block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </span>
      <div className="flex flex-wrap gap-1.5 pointer-coarse:gap-2">{children}</div>
    </div>
  );
}

/**
 * A "Filters" pill that opens one group per non-private enum or
 * array-of-enum field in the filter domains' item schemas (a popover on
 * desktop, a bottom sheet on mobile). Domain is not a group here; it lives in
 * the toolbar's `DomainControl`. Renders nothing when there are no fields.
 */
export function BrowseFiltersPanel({
  domains,
  filterFieldDomains,
  selectedFields,
  onFieldsChange,
  viewMode = 'map',
  trigger = 'toolbar',
}: Readonly<BrowseFiltersPanelProps>) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [open, setOpen] = React.useState(false);

  // Map and list offer the same set of declared, non-private enum fields; the
  // server's facet guard (`resolveAllowedFacetFields`) applies all of them.
  const enumFilterFields: EnumFilterField[] = React.useMemo(
    () => getEnumFilterFieldsForDomains(filterFieldDomains ?? domains),
    [filterFieldDomains, domains],
  );

  const showEnumGroups = enumFilterFields.length > 0;

  const enumActiveCount = Object.values(selectedFields).reduce(
    (sum, vals) => sum + vals.length,
    0,
  );

  const activeCount = enumActiveCount;

  const handleClearAll = () => {
    onFieldsChange({});
  };

  const toggleEnumValue = (fieldKey: string, value: string) => {
    const current = selectedFields[fieldKey] ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    const updated = { ...selectedFields };
    if (next.length === 0) {
      delete updated[fieldKey];
    } else {
      updated[fieldKey] = next;
    }
    onFieldsChange(updated);
  };

  if (!showEnumGroups) return null;

  const renderTrigger = (onClick?: () => void) => (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className={cn(
        'gap-1.5 text-xs',
        // Toolbar: identical chrome to the Sort and Location pills beside it.
        trigger === 'toolbar'
          ? 'h-auto rounded-lg border-border bg-background px-2.5 py-1.5 font-semibold shadow-none'
        // Square on touch like the icon-only Sort and Location beside it;
        // released from `sm` up, where all three show their text.
        + ' pointer-coarse:min-h-11 pointer-coarse:min-w-11 sm:pointer-coarse:min-w-0'
          : 'h-8 border-input bg-background/95 shadow-md backdrop-blur-sm',
        activeCount > 0 && 'border-primary/50 bg-primary/5',
      )}
      aria-label={t('filters.open')}
    >
      <SlidersHorizontal className="size-3.5" />
      {/* Icon-only below sm; the button keeps its aria-label. */}
      <span className="hidden sm:inline">{t('filters.title')}</span>
      {activeCount > 0 && (
        <Badge
          variant="default"
          className="size-4 rounded-full p-0 text-[10px] leading-none"
          aria-label={t('filters.selected', { count: activeCount })}
        >
          {activeCount}
        </Badge>
      )}
    </Button>
  );

  // Shared by the desktop popover and the mobile bottom sheet.
  const panelBody = (
    <>
      {/* Sticky header */}
      <div className="sticky top-0 z-10 flex items-center justify-between rounded-t-xl border-b border-border bg-popover px-4 py-3">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {t('filters.title')}
        </span>
        <div className="flex items-center gap-2 pointer-coarse:gap-4">
          {activeCount > 0 && (
            <button
              type="button"
              onClick={handleClearAll}
              className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('filters.clear_all')}
            >
              {t('filters.clear_all')}
            </button>
          )}
          {/* Close */}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className={cn(
              'relative flex size-5 items-center justify-center rounded-full',
              'bg-muted text-muted-foreground transition-colors',
              'hover:bg-accent hover:text-accent-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              // Enlarges the touch hit area without changing the size-5 circle.
              "pointer-coarse:before:absolute pointer-coarse:before:left-1/2 pointer-coarse:before:top-1/2 pointer-coarse:before:size-11 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']",
            )}
            aria-label={t('filters.close')}
          >
            <X className="size-3" />
          </button>
        </div>
      </div>

      {/* Filter groups */}
      <div className="max-h-[75dvh] space-y-5 overflow-y-auto px-4 py-4">
        {enumFilterFields.map((field) => {
          const fieldSelected = selectedFields[field.key] ?? [];

          // Many options → compact searchable dropdown; few → inline chips.
          if (field.options.length > CHIP_THRESHOLD) {
            return (
              <MultiSelectGroup
                key={field.key}
                title={field.label}
                options={field.options}
                selected={fieldSelected}
                onToggle={(value) => toggleEnumValue(field.key, value)}
              />
            );
          }

          return (
            <FilterGroup key={field.key} title={field.label}>
              {field.options.map((option) => (
                <Chip
                  key={option}
                  label={option}
                  selected={fieldSelected.includes(option)}
                  onToggle={() => toggleEnumValue(field.key, option)}
                  ariaLabel={`Filter by ${field.label}: ${option}`}
                />
              ))}
            </FilterGroup>
          );
        })}

        {activeCount === 0 && (
          <p className="text-[10px] text-muted-foreground">
            {t(viewMode === 'list' ? 'filters.help_list' : 'filters.help')}
          </p>
        )}
      </div>
    </>
  );

  // Mobile: a bottom sheet (ResponsiveDialog renders a Drawer).
  if (isMobile) {
    return (
      <>
        {renderTrigger(() => setOpen(true))}
        {/* The panel header has its own close button, so suppress the
            dialog's. */}
        <ResponsiveDialog
          open={open}
          onOpenChange={setOpen}
          contentClassName="p-0"
          showCloseButton={false}
        >
          {/* Radix Dialog requires an accessible name; the visible header is a
              plain <span>, so the sheet gets a visually hidden title. */}
          <DrawerTitle className="sr-only">{t('filters.title')}</DrawerTitle>
          {panelBody}
        </ResponsiveDialog>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{renderTrigger()}</PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-80 rounded-xl border border-border bg-popover p-0 shadow-lg"
        // Above the maximized map wrapper (z-[2000]).
        style={{ zIndex: 2100 }}
      >
        {panelBody}
      </PopoverContent>
    </Popover>
  );
}
