import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { SlidersHorizontal, X, ChevronDown, Check, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { DotNetworkDomain, ViewMode } from '@/engine/types';
import { getEnumFilterFieldsForDomains } from '@/lib/enum-filters';
import type { EnumFilterField } from '@/lib/enum-filters';

export interface MapFiltersPanelProps {
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
  /** Currently selected domain filter values. Empty array = all. */
  selectedDomains: string[];
  /** Called when the domain filter selection changes. */
  onDomainsChange: (domains: string[]) => void;
  /**
   * Currently selected enum-field filter values.
   * Map of fieldKey → selected option values. Empty array = all.
   */
  selectedFields: Record<string, string[]>;
  /** Called when any enum field filter selection changes. */
  onFieldsChange: (fields: Record<string, string[]>) => void;
  /** Current browse view — tailors the help text (map markers vs listings). */
  viewMode?: ViewMode;
}

// ─── Chip toggle button ────────────────────────────────────────────────────────

interface ChipProps {
  label: string;
  selected: boolean;
  onToggle: () => void;
  title?: string;
  ariaLabel?: string;
}

function Chip({ label, selected, onToggle, title, ariaLabel }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      aria-label={ariaLabel ?? label}
      aria-pressed={selected}
      className={cn(
        'inline-flex cursor-pointer items-center rounded-full border px-2.5 py-1 text-[11px] font-medium leading-none transition-all duration-150',
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

// ─── Filter group (always expanded, chip-based) ───────────────────────────────

interface FilterGroupProps {
  title: string;
  children: React.ReactNode;
}

function FilterGroup({ title, children }: FilterGroupProps) {
  return (
    <div className="space-y-2">
      <span className="block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

// ─── Multi-select dropdown (for groups with many options) ─────────────────────
// When a filter field has more options than CHIP_THRESHOLD, rendering every
// value as a chip is noisy. Instead we show a compact, collapsible dropdown with
// a search box and a scrollable checklist — all still inside the filter panel.

/** Option-count above which a group renders as a dropdown instead of chips. */
const CHIP_THRESHOLD = 8;

interface MultiSelectGroupProps {
  title: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}

function MultiSelectGroup({ title, options, selected, onToggle }: MultiSelectGroupProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const count = selected.length;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left focus-visible:outline-none"
      >
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {title}
        </span>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {count > 0 ? t('filters.selected', { count }) : t('filters.any')}
          <ChevronDown
            className={cn('size-3.5 transition-transform', open && 'rotate-180')}
          />
        </span>
      </button>

      {open && (
        <div className="overflow-hidden rounded-md border border-border bg-background">
          <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('filters.search_placeholder', { field: title.toLowerCase() })}
              className="h-6 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
              aria-label={t('filters.search_placeholder', { field: title })}
            />
          </div>
          <div className="max-h-44 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-2 py-1.5 text-[11px] text-muted-foreground">{t('filters.no_matches')}</p>
            ) : (
              filtered.map((option) => {
                const isSelected = selected.includes(option);
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onToggle(option)}
                    aria-pressed={isSelected}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors',
                      'hover:bg-accent hover:text-accent-foreground',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isSelected ? 'font-medium text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border',
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border',
                      )}
                    >
                      {isSelected && <Check className="size-2.5" />}
                    </span>
                    <span className="truncate">{option}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

/**
 * A "Filters" pill button that opens a polished popover with chip-based filter
 * groups:
 *   1. Domain  — multi-select chips, one per visible domain.
 *   2+. Schema enum fields — one chip group per enum / array-of-enum property
 *       found in the visible domains' item schemas (derived generically).
 *
 * Groups with no options are hidden. All groups are always-expanded since chips
 * are compact. The panel scrolls when content exceeds max-height.
 *
 * Active-filter count is shown as a badge on the trigger pill.  A "Clear all"
 * link in the header resets all groups. An X button closes the popover.
 */
export function MapFiltersPanel({
  domains,
  filterFieldDomains,
  selectedDomains,
  onDomainsChange,
  selectedFields,
  onFieldsChange,
  viewMode = 'map',
}: MapFiltersPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);

  // Derive enum filter fields generically from the filter-field domains
  // (defaults to the visible domains) so the filters can reflect the
  // counterpart being browsed independently of the domain chip selector.
  const enumFilterFields: EnumFilterField[] = React.useMemo(
    () => getEnumFilterFieldsForDomains(filterFieldDomains ?? domains),
    [filterFieldDomains, domains],
  );

  const showDomainGroup = domains.length > 1;
  const showEnumGroups = enumFilterFields.length > 0;

  // Count of active selections across all enum fields
  const enumActiveCount = Object.values(selectedFields).reduce(
    (sum, vals) => sum + vals.length,
    0,
  );

  const activeCount = selectedDomains.length + enumActiveCount;

  const handleClearAll = () => {
    onDomainsChange([]);
    onFieldsChange({});
  };

  const toggleDomain = (domainId: string) => {
    onDomainsChange(
      selectedDomains.includes(domainId)
        ? selectedDomains.filter((d) => d !== domainId)
        : [...selectedDomains, domainId],
    );
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

  // Nothing to filter — don't render the pill at all
  if (!showDomainGroup && !showEnumGroups) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-8 gap-1.5 border border-input bg-background/95 text-xs shadow-md backdrop-blur-sm',
            activeCount > 0 && 'border-primary/50 bg-primary/5',
          )}
          aria-label={t('filters.open')}
        >
          <SlidersHorizontal className="size-3.5" />
          {t('filters.title')}
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
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-80 rounded-xl border border-border bg-popover p-0 shadow-lg"
        // Must sit above the maximized map wrapper (z-[2000]) so the dropdown is
        // visible/clickable in maximized mode, and above normal overlays otherwise.
        style={{ zIndex: 2100 }}
      >
        {/* ── Sticky header ──────────────────────────────────────────────────── */}
        <div className="sticky top-0 z-10 flex items-center justify-between rounded-t-xl border-b border-border bg-popover px-4 py-3">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {t('filters.title')}
          </span>
          <div className="flex items-center gap-2">
            {activeCount > 0 && (
              <button
                type="button"
                onClick={handleClearAll}
                className="text-[10px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('filters.clear_all')}
              >
                {t('filters.clear_all')}
              </button>
            )}
            {/* X close button */}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={cn(
                'flex size-5 items-center justify-center rounded-full',
                'bg-muted text-muted-foreground transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
              aria-label={t('filters.close')}
            >
              <X className="size-3" />
            </button>
          </div>
        </div>

        {/* ── Scrollable filter groups ────────────────────────────────────────── */}
        <div className="max-h-[75vh] space-y-5 overflow-y-auto px-4 py-4">
          {showDomainGroup && (
            <FilterGroup title={t('filters.domain_group')}>
              {domains.map((domain) => {
                const label = domain.id
                  .replace(/_/g, ' ')
                  .replace(/\b\w/g, (c) => c.toUpperCase());
                return (
                  <Chip
                    key={domain.id}
                    label={label}
                    selected={selectedDomains.includes(domain.id)}
                    onToggle={() => toggleDomain(domain.id)}
                    ariaLabel={`Filter by domain: ${label}`}
                  />
                );
              })}
            </FilterGroup>
          )}

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
      </PopoverContent>
    </Popover>
  );
}
