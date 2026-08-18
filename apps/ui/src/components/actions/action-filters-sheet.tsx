import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { useIsMobile } from '@/hooks/use-mobile';
import type { DotNetworkDomain } from '@/engine/types';
import { getEnumFilterFieldsForDomains } from '@/lib/enum-filters';
import { MultiSelectGroup, CHIP_THRESHOLD } from '@/components/filters/multi-select-group';
import {
  ACTION_STATUS_FILTERS,
  STATUS_LABEL_KEYS,
  type ActionStatusFilter,
} from '@/components/actions/action-toolbar';

/** The two action kinds a network action can be — see `action-modal.tsx`'s `action_type`. */
export type ActionTypeFilter = 'connect' | 'apply';

const ACTION_TYPE_OPTIONS: Array<{ value: ActionTypeFilter; labelKey: string; defaultLabel: string }> = [
  { value: 'connect', labelKey: 'actions.type_connect', defaultLabel: 'Connect' },
  { value: 'apply', labelKey: 'actions.type_apply', defaultLabel: 'Apply' },
];

export interface ActionFiltersSheetProps {
  /** Whether the slide-over is open. */
  open: boolean;
  /**
   * The counterparty domain(s) whose item schemas drive the facet groups
   * (via `getEnumFilterFieldsForDomains`, which already excludes
   * `private: true` fields — see #394's defense-in-depth rule).
   */
  domains: DotNetworkDomain[];
  /**
   * Selected schema-derived facet values, keyed by `EnumFilterField.key`.
   * Deliberately does NOT include action type — the `/action/fetch` API
   * sends `action_type` as its own query param, distinct from the `facets`
   * array these keys map to (see `action-api.ts`'s `FetchMyActionsQuery`),
   * so keeping them as separate props avoids overloading one map with two
   * different wire shapes (and avoids a collision if a network schema ever
   * declares its own `action_type` enum field).
   */
  selected: Record<string, string[]>;
  /** Called with the next `selected` map whenever a facet checkbox is toggled. */
  onChange: (next: Record<string, string[]>) => void;
  /** Selected status filter (single-select: All / Pending / Accepted / Rejected). */
  status: ActionStatusFilter;
  /** Called with the next status when a status option is chosen. */
  onStatusChange: (next: ActionStatusFilter) => void;
  /** Selected action types (Connect / Apply). */
  actionTypes: ActionTypeFilter[];
  /** Called with the next `actionTypes` array whenever an action-type checkbox is toggled. */
  onActionTypesChange: (next: ActionTypeFilter[]) => void;
  /** Called when the sheet should close (X button, overlay click, or Done). */
  onClose: () => void;
}

/**
 * Schema-driven filters slide-over for the My Actions page (#439 Task 11).
 * Renders an Action type group (Connect/Apply — fixed, not schema-derived)
 * plus one checkbox group per non-private enum field declared on the
 * counterparty domain(s)' item schemas. Presentational only: all state is
 * owned by the caller (Task 13 wires this to the page's URL-backed filter
 * state) and every change is reported via `onChange`/`onActionTypesChange`.
 *
 * Deliberately excludes a distance control (sort-only, not a filter) and any
 * PII field (`getEnumFilterFieldsForDomains` already drops `private: true`
 * fields — PII is never offered as a filter, per #394).
 */
export function ActionFiltersSheet({
  open,
  domains,
  selected,
  onChange,
  status,
  onStatusChange,
  actionTypes,
  onActionTypesChange,
  onClose,
}: Readonly<ActionFiltersSheetProps>) {
  const { t } = useTranslation();

  const enumFilterFields = React.useMemo(() => getEnumFilterFieldsForDomains(domains), [domains]);

  const toggleActionType = (value: ActionTypeFilter) => {
    onActionTypesChange(
      actionTypes.includes(value) ? actionTypes.filter((v) => v !== value) : [...actionTypes, value],
    );
  };

  const toggleFacetValue = (fieldKey: string, value: string) => {
    const current = selected[fieldKey] ?? [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    const updated = { ...selected };
    if (next.length === 0) {
      delete updated[fieldKey];
    } else {
      updated[fieldKey] = next;
    }
    onChange(updated);
  };

  const isMobile = useIsMobile();

  const closeButton = (
    <Button
      type="button"
      onClick={onClose}
      data-testid="action-filters-done"
      className={isMobile ? 'w-full' : undefined}
    >
      {t('filters.close', 'Close filters')}
    </Button>
  );

  // Shared filter content (status + action type + facets), rendered inside a
  // right Sheet on desktop and a bottom Drawer on mobile.
  const filterBody = (
    <>
          {/* Status — single-select (All / Pending / Accepted / Rejected). Lives
              here (My Actions only) rather than in the map/list filter panel,
              since status is an action concept. */}
          <section className="space-y-2" aria-labelledby="action-filters-status-heading">
            <h3
              id="action-filters-status-heading"
              className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
            >
              {t('actions.status_group', 'Status')}
            </h3>
            <div className="inline-flex flex-wrap gap-1 rounded-xl border bg-card p-1">
              {ACTION_STATUS_FILTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  data-testid={`status-option-${s}`}
                  aria-pressed={s === status}
                  onClick={() => onStatusChange(s)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition pointer-coarse:min-h-11 ${
                    s === status ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t(STATUS_LABEL_KEYS[s])}
                </button>
              ))}
            </div>
          </section>

          {/* Action type — fixed Connect/Apply, not schema-derived */}
          <section className="space-y-2" aria-labelledby="action-filters-type-heading">
            <h3
              id="action-filters-type-heading"
              className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
            >
              {t('actions.type_group', 'Action type')}
            </h3>
            <div className="space-y-1">
              {ACTION_TYPE_OPTIONS.map((option) => {
                const label = t(option.labelKey, option.defaultLabel);
                return (
                  <label
                    key={option.value}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-sm hover:bg-accent"
                  >
                    <Checkbox
                      checked={actionTypes.includes(option.value)}
                      onCheckedChange={() => toggleActionType(option.value)}
                      aria-label={label}
                    />
                    <span>{label}</span>
                  </label>
                );
              })}
            </div>
          </section>

          {/* One group per schema-derived, non-private enum field. Fields with
              many options render as a compact searchable dropdown (shared with
              the map/list filters) so the sheet stays short; small fields stay
              as an inline checkbox list. Schema-provided labels are not
              translated, per the repo's rule that schema content isn't localized. */}
          {enumFilterFields.map((field) => {
            const fieldSelected = selected[field.key] ?? [];

            if (field.options.length > CHIP_THRESHOLD) {
              return (
                <MultiSelectGroup
                  key={field.key}
                  title={field.label}
                  options={field.options}
                  selected={fieldSelected}
                  onToggle={(value) => toggleFacetValue(field.key, value)}
                />
              );
            }

            return (
              <section key={field.key} className="space-y-2" aria-labelledby={`action-filters-${field.key}-heading`}>
                <h3
                  id={`action-filters-${field.key}-heading`}
                  className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
                >
                  {field.label}
                </h3>
                <div className="space-y-1">
                  {field.options.map((option) => (
                    <label
                      key={option}
                      className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-sm hover:bg-accent"
                    >
                      <Checkbox
                        checked={fieldSelected.includes(option)}
                        onCheckedChange={() => toggleFacetValue(field.key, option)}
                        aria-label={option}
                      />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              </section>
            );
          })}
    </>
  );

  // Mobile: a bottom-sheet Drawer (ResponsiveDialog) — matches the map/list
  // filters' mobile shape and avoids the full-screen right panel.
  if (isMobile) {
    return (
      <ResponsiveDialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onClose();
        }}
        title={t('filters.title', 'Filters')}
      >
        <div className="flex max-h-[85svh] flex-col">
          <div className="border-b px-4 py-4">
            <h2 className="text-base font-semibold">{t('filters.title', 'Filters')}</h2>
          </div>
          <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">{filterBody}</div>
          <div className="border-t p-4">{closeButton}</div>
        </div>
      </ResponsiveDialog>
    );
  }

  // Desktop: right slide-over Sheet.
  return (
    <Sheet open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <SheetContent side="right" className="flex h-full w-full flex-col sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>{t('filters.title', 'Filters')}</SheetTitle>
        </SheetHeader>
        <div className="flex-1 space-y-6 overflow-y-auto px-4">{filterBody}</div>
        <SheetFooter>{closeButton}</SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
