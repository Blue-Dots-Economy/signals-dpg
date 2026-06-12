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

  // Fields: default rows always, extra rows when expanded. On the DESKTOP popup
  // this region alone scrolls (the footer stays pinned). On mobile it does not
  // scroll on its own — the whole body wrapper scrolls instead (see below) so
  // the action buttons are always reachable.
  const fieldsBlock = (
    <div
      className={cn(
        'space-y-2 px-4 py-3',
        variant === 'popup' && 'sm:min-h-0 sm:flex-1 sm:overflow-y-auto'
      )}
    >
      {resolved.defaultRows.map((row) => (
        <FieldRow key={row.key} row={row} />
      ))}
      {open &&
        resolved.extraRows.map((row) => <FieldRow key={row.key} row={row} />)}
    </div>
  );

  // Footer: the "view more" toggle + action buttons. On a list card it is
  // pinned to the bottom (mt-auto) for equal-height rows. On the popup it is
  // pinned only on desktop (sm:mt-auto); on mobile it flows at the end of the
  // scrolling body so it can never be clipped when the fields expand.
  const footerBlock = (hasExtra || actions) ? (
    <div
      className={cn(
        'shrink-0 pt-1',
        variant === 'list' ? 'mt-auto' : 'sm:mt-auto'
      )}
    >
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

      {/* Action buttons — supplied by the caller. justify-between spreads
          natural-width list buttons to the edges; the popup's buttons use
          flex-1 so they fill instead. */}
      {actions && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-4 pt-2">
          {actions}
        </div>
      )}
    </div>
  ) : null;

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
        //  - height: on mobile a compact 58vh so an opened card never fills the
        //    screen; the whole body scrolls within it. On desktop ≤ 28rem (and
        //    ≤ 60vh on short screens) with the footer pinned.
        variant === 'popup' &&
          'w-[min(28rem,90vw)] max-h-[58vh] sm:max-h-[min(60vh,28rem)]',
        variant === 'list' &&
          'transition hover:shadow-md motion-safe:hover:-translate-y-0.5',
        className
      )}
      onClick={onClick}
    >
      {/* Branded header — colour is the per-network theme var */}
      <div
        className="flex shrink-0 items-center gap-3 px-4 py-2.5 sm:py-3"
        style={{ background: HEADER_GRADIENT }}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/25 text-sm font-bold text-white sm:h-11 sm:w-11">
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

      {/* Body. Popup on mobile: fields + footer share ONE scroll area, so the
          action buttons are always reachable (even after "view more" expands
          the fields). Popup on desktop (sm+): the body itself doesn't scroll —
          the fields region scrolls internally and the footer stays pinned
          (unchanged). List: fields followed by the bottom-pinned footer. */}
      {variant === 'popup' ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto sm:overflow-hidden">
          {fieldsBlock}
          {footerBlock}
        </div>
      ) : (
        <>
          {fieldsBlock}
          {footerBlock}
        </>
      )}
    </div>
  );
}
