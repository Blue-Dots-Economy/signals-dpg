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
import { UriValue } from './uri-value';

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
  /** Optional node rendered top-right of the coloured header (e.g. a Share button). */
  headerAction?: React.ReactNode;
  /** When set, the avatar shows this image instead of the initials. */
  avatarImageUrl?: string;
  /** `popup` is the map marker card; `list` is the browse grid card. */
  variant?: 'popup' | 'list';
  className?: string;
  onClick?: () => void;
}

const HEADER_GRADIENT =
  'linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary), white 32%))';

// Long text values are truncated with an inline "Show more" toggle.
const LONG_VALUE_PREVIEW_CHARS = 140;

function FieldRow({ row, compact = false }: { row: CardRow; compact?: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  const formatted = formatCardValue(row.value, row.type);
  // A link row skips the "Show more" toggle: UriValue elides its own display
  // text and keeps the full value in the href + tooltip.
  const isLong = !row.isUri && formatted.length > LONG_VALUE_PREVIEW_CHARS;
  const display =
    isLong && !expanded
      ? `${formatted.slice(0, LONG_VALUE_PREVIEW_CHARS).trimEnd()}… `
      : formatted;

  return (
    <div
      className={cn(
        'flex items-start gap-3 text-sm',
        // Popup on mobile: tighter rows + smaller text so the card stays small.
        compact && 'gap-2 text-xs sm:gap-3 sm:text-sm'
      )}
    >
      <span
        className={cn(
          'shrink-0 font-medium text-muted-foreground',
          compact ? 'w-[80px] sm:w-[110px]' : 'w-[110px]'
        )}
      >
        {row.label}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 [overflow-wrap:anywhere]',
          row.isEmpty ? 'text-muted-foreground/60' : 'text-foreground'
        )}
      >
        {row.isUri ? <UriValue value={row.value} /> : display}
        {isLong && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            // z-10: stay above the whole-card activation button (see CardShell).
            className="relative z-10 font-medium text-primary hover:underline"
          >
            {expanded ? t('card.show_less', 'Show less') : t('card.show_more', 'Show more')}
          </button>
        )}
      </span>
    </div>
  );
}

type CardShellProps = Omit<React.ComponentPropsWithoutRef<'div'>, 'onClick'> & {
  /** Accessible name for the whole-card activation control. */
  heading: string;
  /** When given, the card gains a whole-card activation control. */
  onClick?: () => void;
};

/**
 * The card's outer element. With an `onClick`, a real `<button>` is stretched
 * over the card as a sibling of the content, labelled with the card title.
 * Wrapping the card in a button (or `role="button"`) would nest the footer's
 * controls inside it (axe `nested-interactive`, WCAG 4.1.2). The card's own
 * controls sit above the stretched button via `relative z-10`.
 */
function CardShell({
  heading,
  onClick,
  className,
  children,
  ...rest
}: Readonly<CardShellProps>) {
  if (!onClick) {
    return (
      <div className={className} {...rest}>
        {children}
      </div>
    );
  }

  return (
    <div className={className} {...rest}>
      <button
        type="button"
        onClick={onClick}
        aria-label={heading}
        // Inset focus ring, since the card root clips overflow.
        className="absolute inset-0 cursor-pointer rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      />
      {children}
    </div>
  );
}

/**
 * Card for the map popup and the browse list. The domain's `card.default_fields`
 * render collapsed; "view more" reveals the rest. Buttons come in via
 * `actions`, so each call site keeps its own auth gating.
 */
export function ItemCard({
  schema,
  data,
  cardConfig,
  title,
  domainLabel,
  precisionLabel,
  actions,
  headerAction,
  avatarImageUrl,
  variant = 'list',
  className,
  onClick,
}: Readonly<ItemCardProps>) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);

  const resolved = resolveCardFields(schema, data, cardConfig);
  const heading = title ?? resolved.title;
  const hasExtra = resolved.extraRows.length > 0;

  // On the desktop popup this region scrolls with the footer pinned; on
  // mobile the whole body scrolls so the buttons stay reachable.
  const fieldsBlock = (
    <div
      className={cn(
        'space-y-2 px-4 py-3',
        variant === 'popup' &&
          'space-y-1.5 px-3 py-2.5 sm:min-h-0 sm:flex-1 sm:space-y-2 sm:overflow-y-auto sm:px-4 sm:py-3'
      )}
    >
      {resolved.defaultRows.map((row) => (
        <FieldRow key={row.key} row={row} compact={variant === 'popup'} />
      ))}
      {open &&
        resolved.extraRows.map((row) => (
          <FieldRow key={row.key} row={row} compact={variant === 'popup'} />
        ))}
    </div>
  );

  // Footer: pinned to the bottom on list cards (equal-height rows) and on the
  // desktop popup; on mobile it flows at the end of the scrolling body.
  const footerBlock = (hasExtra || actions) ? (
    <div
      className={cn(
        // z-10: above the whole-card button (see CardShell).
        'relative z-10 shrink-0 pt-1',
        variant === 'list' ? 'mt-auto' : 'sm:mt-auto'
      )}
    >
      {hasExtra && (
        <div className={cn('px-4 pb-1', variant === 'popup' && 'px-3 sm:px-4')}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            className={cn(
              'flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-muted/40 py-2 text-[13px] font-semibold text-primary hover:bg-muted',
              variant === 'popup' && 'py-1.5 text-xs sm:py-2 sm:text-[13px]'
            )}
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

      {/* Caller-supplied buttons: spread on list cards, filled on popups. */}
      {actions && (
        <div
          data-tour="card-actions"
          className={cn(
            'flex flex-wrap items-center justify-between gap-2 px-4 pb-4 pt-2',
            variant === 'popup' &&
              'gap-1.5 px-3 pb-3 pt-1.5 sm:gap-2 sm:px-4 sm:pb-4 sm:pt-2'
          )}
        >
          {actions}
        </div>
      )}
    </div>
  ) : null;

  return (
    <CardShell
      heading={heading}
      data-item-card={variant === 'list' ? '' : undefined}
      data-expanded={variant === 'list' ? open : undefined}
      className={cn(
        // `relative` contains CardShell's stretched button; `isolate` keeps the
        // z-10 layering local to the card.
        'relative isolate flex flex-col overflow-hidden rounded-2xl bg-background text-foreground shadow-sm',
        // Map popup: bounded in both dimensions so it always fits. A definite
        // width (17rem on mobile, leaving room to pan; 28rem from sm, which
        // fits three buttons in a row) wraps long values instead of widening.
        variant === 'popup' &&
          'w-[min(17rem,86vw)] max-h-[56dvh] sm:w-[min(28rem,90vw)] sm:max-h-[min(60dvh,28rem)]',
        variant === 'list' &&
          'transition hover:shadow-md motion-safe:hover:-translate-y-0.5',
        className
      )}
      onClick={onClick}
    >
      {/* Header in the network theme colour */}
      <div
        className="flex shrink-0 items-center gap-2.5 px-3 py-2 sm:gap-3 sm:px-4 sm:py-3"
        style={{ background: HEADER_GRADIENT }}
      >
        <div
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-bold text-white sm:h-11 sm:w-11 sm:text-sm',
            avatarImageUrl ? 'bg-white' : 'bg-white/25'
          )}
        >
          {avatarImageUrl ? (
            <img src={avatarImageUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            resolved.initials
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold leading-tight text-white sm:text-[15px]">
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
        {/* z-10: above the whole-card button (see CardShell). */}
        {headerAction && <div className="relative z-10 ml-auto shrink-0">{headerAction}</div>}
      </div>

      {/* Mobile popup: fields and footer share one scroll area. Desktop popup:
          only the fields scroll. */}
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
    </CardShell>
  );
}
