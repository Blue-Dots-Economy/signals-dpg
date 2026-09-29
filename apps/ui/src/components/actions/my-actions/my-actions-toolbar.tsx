import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, RefreshCw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useIsMobile } from '@/hooks/use-mobile';
import type { EnumFilterField } from '@/lib/enum-filters';
import {
  activeFilterCount,
  type ActionSortKey,
  type Direction,
  type MyActionsFilter,
  type SavedViewId,
  SORT_KEYS,
} from '@/lib/my-actions-view';
import type { OwnedActionCounts } from '@/lib/action-api';

export interface ProfileOption {
  id: string;
  label: string;
}

/** Schema-driven filter fields of one counterparty domain. */
export interface FacetGroup {
  domain: string;
  domainLabel: string;
  fields: EnumFilterField[];
}

export type ColumnId = 'action' | 'direction' | 'status' | 'profile' | 'match' | 'distance' | 'updated';
export const COLUMN_IDS: readonly ColumnId[] = [
  'action',
  'direction',
  'status',
  'profile',
  'match',
  'distance',
  'updated',
];

interface MyActionsToolbarProps {
  filter: MyActionsFilter;
  onChange: (next: MyActionsFilter) => void;
  profiles: ProfileOption[];
  statuses: string[];
  statusLabel: (status: string) => string;
  types: string[];
  facetGroups: FacetGroup[];
  columns: Record<ColumnId, boolean>;
  onToggleColumn: (id: ColumnId) => void;
  savedView: SavedViewId | null;
  counts?: OwnedActionCounts;
  onSavedView: (view: SavedViewId) => void;
  onRefresh: () => void;
  refreshing?: boolean;
}

const toggle = (values: readonly string[], v: string) =>
  values.includes(v) ? values.filter((x) => x !== v) : [...values, v];

function TriggerButton({
  label,
  value,
  active,
  ...rest
}: { label: string; value?: string; active?: boolean } & React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={`h-9 gap-1.5 ${active ? 'border-primary bg-primary/5 text-primary' : ''}`}
      {...rest}
    >
      {label}
      {value ? (
        <span className={active ? 'font-semibold text-primary' : 'font-normal text-muted-foreground'}>{value}</span>
      ) : null}
      <ChevronDown className="h-3.5 w-3.5 opacity-60" />
    </Button>
  );
}

/**
 * Toolbar of the My Actions table: search, profiles, filters (status,
 * direction, action type and the counterparty's schema-driven fields), sort,
 * columns and saved views. Every change produces a new `MyActionsFilter`; the
 * page owns the state (in the URL).
 */
export function MyActionsToolbar({
  filter,
  onChange,
  profiles,
  statuses,
  statusLabel,
  types,
  facetGroups,
  columns,
  onToggleColumn,
  savedView,
  counts,
  onSavedView,
  onRefresh,
  refreshing,
}: Readonly<MyActionsToolbarProps>) {
  const { t } = useTranslation();
  const isMobile = useIsMobile(); // phones get cards — no columns to pick
  const [q, setQ] = React.useState(filter.q);
  React.useEffect(() => setQ(filter.q), [filter.q]);

  // Debounced search: typing shouldn't fire a request per keystroke.
  React.useEffect(() => {
    if (q === filter.q) return;
    const id = setTimeout(() => onChange({ ...filter, q, page: 1 }), 350);
    return () => clearTimeout(id);
  }, [q, filter, onChange]);

  const set = (patch: Partial<MyActionsFilter>) => onChange({ ...filter, ...patch, page: 1 });
  const nFilters = activeFilterCount(filter);
  const facetValues = (domain: string, field: string) =>
    filter.facets.find((f) => f.domain === domain && f.field === field)?.values ?? [];
  const toggleFacet = (domain: string, field: string, value: string) => {
    const rest = filter.facets.filter((f) => !(f.domain === domain && f.field === field));
    const values = toggle(facetValues(domain, field), value);
    set({ facets: values.length > 0 ? [...rest, { domain, field, values }] : rest });
  };

  const sortLabel: Record<ActionSortKey, string> = {
    recent: t('my_actions.sort_recent', 'Updated ↓'),
    oldest: t('my_actions.sort_oldest', 'Updated ↑'),
    match_score: t('my_actions.sort_match', 'Match score ↓'),
    distance: t('my_actions.sort_distance', 'Distance ↑'),
  };
  const columnLabel: Record<ColumnId, string> = {
    action: t('my_actions.col_action', 'Action'),
    direction: t('my_actions.col_direction', 'Direction'),
    status: t('my_actions.col_status', 'Status'),
    profile: t('my_actions.col_profile', 'Profile'),
    match: t('my_actions.col_match', 'Match score'),
    distance: t('my_actions.col_distance', 'Distance'),
    updated: t('my_actions.col_updated', 'Updated'),
  };
  const views: Array<{ id: SavedViewId; label: string; count?: number }> = [
    { id: 'all', label: t('my_actions.view_all', 'All actions'), count: counts?.all },
    { id: 'needs_response', label: t('my_actions.view_needs_response', 'Needs my response'), count: counts?.needs_response },
    { id: 'ready_to_export', label: t('my_actions.view_ready_to_export', 'Ready to export'), count: counts?.ready_to_export },
    { id: 'sent', label: t('my_actions.view_sent', 'Sent by me'), count: counts?.sent },
  ];
  const directionLabel: Record<Direction, string> = {
    all: t('my_actions.dir_all', 'Sent and received'),
    received: t('my_actions.dir_received', 'Received'),
    sent: t('my_actions.dir_sent', 'Sent'),
  };
  let profileValue = String(filter.profiles.length);
  if (filter.profiles.length === 0) profileValue = t('my_actions.profiles_all', 'All');
  else if (filter.profiles.length === 1) {
    profileValue = profiles.find((p) => p.id === filter.profiles[0])?.label ?? '1';
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-md border bg-background px-3 text-muted-foreground sm:flex-none sm:basis-72">
        <Search className="h-4 w-4 shrink-0" />
        <span className="sr-only">{t('my_actions.search_label', 'Search')}</span>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('my_actions.search_placeholder', 'Search name or job…')}
          className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
        />
        {q ? (
          <button type="button" onClick={() => setQ('')} aria-label={t('my_actions.clear_search', 'Clear search')}>
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </label>

      {profiles.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TriggerButton
              label={t('my_actions.profiles', 'Profiles')}
              value={profileValue}
              active={filter.profiles.length > 0}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel>{t('my_actions.show_actions_for', 'Show actions for')}</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={filter.profiles.length === 0}
              onCheckedChange={() => set({ profiles: [] })}
              onSelect={(e) => e.preventDefault()}
            >
              {t('my_actions.profiles_all_long', 'All profiles')}
            </DropdownMenuCheckboxItem>
            {profiles.map((p) => (
              <DropdownMenuCheckboxItem
                key={p.id}
                checked={filter.profiles.includes(p.id)}
                onCheckedChange={() => set({ profiles: toggle(filter.profiles, p.id) })}
                onSelect={(e) => e.preventDefault()}
              >
                {p.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <Popover>
        <PopoverTrigger asChild>
          <TriggerButton
            label={t('my_actions.filter', 'Filter')}
            value={nFilters > 0 ? String(nFilters) : undefined}
            active={nFilters > 0}
          />
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-[70dvh] w-80 overflow-y-auto p-3">
          <FilterSection title={t('my_actions.filter_direction', 'Direction')}>
            {(['all', 'received', 'sent'] as const).map((d) => (
              <Choice key={d} checked={filter.direction === d} radio onChange={() => set({ direction: d })}>
                {directionLabel[d]}
              </Choice>
            ))}
          </FilterSection>
          <FilterSection title={t('my_actions.filter_status', 'Status')}>
            {statuses.map((s) => (
              <Choice
                key={s}
                checked={filter.statuses.includes(s)}
                onChange={() => set({ statuses: toggle(filter.statuses, s) })}
              >
                {statusLabel(s)}
              </Choice>
            ))}
          </FilterSection>
          {types.length > 1 ? (
            <FilterSection title={t('my_actions.filter_type', 'Action type')}>
              {types.map((ty) => (
                <Choice key={ty} checked={filter.types.includes(ty)} onChange={() => set({ types: toggle(filter.types, ty) })}>
                  {t(`actions.type_${ty}`, ty.charAt(0).toUpperCase() + ty.slice(1))}
                </Choice>
              ))}
            </FilterSection>
          ) : null}
          {facetGroups.flatMap((g) =>
            g.fields.map((field) => (
              <FilterSection
                key={`${g.domain}.${field.key}`}
                title={field.label}
                hint={facetGroups.length > 1 ? g.domainLabel : undefined}
              >
                {field.options.map((opt) => (
                  <Choice
                    key={opt}
                    checked={facetValues(g.domain, field.key).includes(opt)}
                    onChange={() => toggleFacet(g.domain, field.key, opt)}
                  >
                    {opt}
                  </Choice>
                ))}
              </FilterSection>
            )),
          )}
          {nFilters > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 w-full"
              onClick={() => set({ statuses: [], types: [], direction: 'all', facets: [] })}
            >
              {t('my_actions.clear_filters', 'Clear filters')}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <TriggerButton
            label={t('my_actions.sort', 'Sort')}
            value={sortLabel[filter.sort]}
            active={filter.sort !== 'recent'}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup value={filter.sort} onValueChange={(v) => set({ sort: v as ActionSortKey })}>
            {SORT_KEYS.map((k) => (
              <DropdownMenuRadioItem key={k} value={k}>
                {sortLabel[k]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {isMobile ? null : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <TriggerButton
            label={t('my_actions.columns', 'Columns')}
            value={`${COLUMN_IDS.filter((c) => columns[c]).length + 1}/${COLUMN_IDS.length + 1}`}
            active={COLUMN_IDS.some((c) => !columns[c])}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t('my_actions.show_columns', 'Show columns')}</DropdownMenuLabel>
          {COLUMN_IDS.map((c) => (
            <DropdownMenuCheckboxItem
              key={c}
              checked={columns[c]}
              onCheckedChange={() => onToggleColumn(c)}
              onSelect={(e) => e.preventDefault()}
            >
              {columnLabel[c]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <TriggerButton
            label={t('my_actions.views', 'Views')}
            value={views.find((v) => v.id === savedView)?.label ?? t('my_actions.view_custom', 'Custom')}
            active={savedView !== 'all'}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          {views.map((v) => (
            <DropdownMenuItem key={v.id} onSelect={() => onSavedView(v.id)} className="justify-between">
              <span className={savedView === v.id ? 'font-semibold text-primary' : ''}>{v.label}</span>
              {v.count != null ? <span className="text-xs text-muted-foreground">{v.count}</span> : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {t('my_actions.views_hint', 'Views keep your profile, search and field filters.')}
          </p>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex-1" />
      <Button
        variant="outline"
        size="icon"
        className="h-9 w-9"
        onClick={onRefresh}
        aria-label={t('my_actions.refresh', 'Refresh')}
      >
        <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
      </Button>
    </div>
  );
}

function FilterSection({
  title,
  hint,
  children,
}: Readonly<{ title: string; hint?: string; children: React.ReactNode }>) {
  return (
    <fieldset className="mb-3">
      <legend className="mb-1 flex w-full items-baseline justify-between text-xs font-semibold text-muted-foreground">
        <span>{title}</span>
        {hint ? <span className="font-normal">{hint}</span> : null}
      </legend>
      <div className="flex flex-col">{children}</div>
    </fieldset>
  );
}

function Choice({
  checked,
  onChange,
  radio,
  children,
}: Readonly<{ checked: boolean; onChange: () => void; radio?: boolean; children: React.ReactNode }>) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted">
      <input
        type={radio ? 'radio' : 'checkbox'}
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 accent-primary"
      />
      {children}
    </label>
  );
}
