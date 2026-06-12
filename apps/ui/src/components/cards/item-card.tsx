import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { RJSFSchema } from '@rjsf/utils';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { DotCardConfig } from '@/engine/types';
import {
  resolveCardFields,
  formatCardValue,
  type CardRow,
} from './resolve-card-fields';

export interface ItemCardProps {
  /** Item schema (drives field labels). May be absent for map markers. */
  schema?: RJSFSchema | null;
  data: Record<string, unknown>;
  /** Per-domain card config from network.json. */
  cardConfig?: DotCardConfig | null;
  /** Override the resolved title (e.g. the map marker label). */
  title?: string;
  /** Badge text under the title (e.g. "Practitioner"). */
  domainLabel?: string;
  /** Small location/precision line (e.g. "Exact location"). */
  precisionLabel?: string;
  /** Action buttons (Connect / See Match Score) rendered in the footer. */
  actions?: React.ReactNode;
  /** `popup` is the map marker card; `list` is the browse grid card. */
  variant?: 'popup' | 'list';
  className?: string;
  onClick?: () => void;
}

const HEADER_GRADIENT =
  'linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary), white 32%))';

function FieldRow({ row }: { row: CardRow }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="w-[110px] shrink-0 font-medium text-muted-foreground">
        {row.label}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 [overflow-wrap:anywhere]',
          row.isEmpty ? 'text-muted-foreground/60' : 'text-foreground'
        )}
      >
        {formatCardValue(row.value, row.type)}
      </span>
    </div>
  );
}

/**
 * Single card component shared by the map popup and the browse list. Default
 * fields (from the domain's network.json `card` block) render collapsed; a
 * "view more" accordion reveals the remaining schema fields. Connect / See
 * Match Score buttons are passed in via `actions` so each call site keeps its
 * own auth/profile gating.
 */
export function ItemCard({
  schema,
  data,
  cardConfig,
  title,
  domainLabel,
  precisionLabel,
  actions,
  variant = 'list',
  className,
  onClick,
}: ItemCardProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);

  const resolved = resolveCardFields(schema, data, cardConfig);
  const heading = title ?? resolved.title;
  const hasExtra = resolved.extraRows.length > 0;

  return (
    <div
      data-item-card={variant === 'list' ? '' : undefined}
      data-expanded={variant === 'list' ? open : undefined}
      className={cn(
        'flex flex-col overflow-hidden rounded-2xl bg-background text-foreground shadow-sm',
        // Map popup: bound BOTH dimensions so the card always fits the screen.
        //  - width: a fixed 28rem (wide enough for the three action buttons on
        //    one row, and so fewer field values wrap → a shorter card), capped
        //    at 90vw so it never exceeds a phone viewport. Being a definite
        //    width, long field values wrap to the next line rather than widening
        //    the card.
        //  - height: ≤ 28rem, and never more than 60vh, so even above a marker
        //    near the bottom of a short screen the whole card fits — header and
        //    footer (Call / Website / Get Directions) stay pinned and the fields
        //    region between them scrolls.
        variant === 'popup' && 'w-[min(28rem,90vw)] max-h-[min(60vh,28rem)]',
        variant === 'list' &&
          'transition hover:shadow-md motion-safe:hover:-translate-y-0.5',
        className
      )}
      onClick={onClick}
    >
      {/* Branded header — colour is the per-network theme var */}
      <div
        className="flex shrink-0 items-center gap-3 px-4 py-3"
        style={{ background: HEADER_GRADIENT }}
      >
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/25 text-sm font-bold text-white">
          {resolved.initials}
        </div>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-bold leading-tight text-white">
            {heading}
          </p>
          {domainLabel && (
            <Badge className="mt-1 border-0 bg-white/25 px-1.5 py-0 text-[10px] font-semibold text-white hover:bg-white/25">
              {domainLabel}
            </Badge>
          )}
          {precisionLabel && (
            <p className="mt-1 text-[10px] leading-none text-white/85">
              {precisionLabel}
            </p>
          )}
        </div>
      </div>

      {/* Fields: default rows always, extra rows when expanded. In the map popup
          this region flexes and scrolls so a long list (e.g. many service
          cities) stays reachable without pushing the action buttons off-screen. */}
      <div
        className={cn(
          'space-y-2 px-4 py-3',
          variant === 'popup' && 'min-h-0 flex-1 overflow-y-auto'
        )}
      >
        {resolved.defaultRows.map((row) => (
          <FieldRow key={row.key} row={row} />
        ))}
        {open &&
          resolved.extraRows.map((row) => <FieldRow key={row.key} row={row} />)}
      </div>

      {/* Footer pinned to the bottom (mt-auto): when a card is taller than its
          content (equal-height rows), the extra space sits above the footer —
          after the last field — never below the buttons. */}
      {(hasExtra || actions) && (
        <div className="mt-auto shrink-0 pt-1">
          {hasExtra && (
            <div className="px-4 pb-1">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen((v) => !v);
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-muted/40 py-2 text-[13px] font-semibold text-primary hover:bg-muted"
              >
                {open
                  ? t('card.hide_details', 'Hide details')
                  : t('card.view_more', 'View more details')}
                <ChevronDown
                  className={cn(
                    'h-4 w-4 transition-transform',
                    open && 'rotate-180'
                  )}
                />
              </button>
            </div>
          )}

          {/* Action buttons (Connect / See Match Score) — supplied by the caller.
              justify-between spreads natural-width list buttons to the left/right
              edges; the map popup's buttons use flex-1 so they fill instead. */}
          {actions && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-4 pt-2">
              {actions}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
