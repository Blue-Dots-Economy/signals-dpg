import { Star, Navigation, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatCardMetric, describeCardMetric } from '@/lib/metric-display';
import type { CardMetric } from '@/lib/metric-display';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export interface MatchScoreBadgeProps {
  /**
   * The card's ranking basis (relevance %, distance or age), resolved from the
   * sort the server applied, so a list is never badged with a metric it was
   * not ordered by.
   */
  metric: CardMetric;
  /**
   * Which quantity `relevance` means: 'profile' when an anchor supplied the
   * cosine, 'search' when the typed text was the query vector. Used only for
   * the tooltip sentence.
   */
  basis: 'profile' | 'search' | null;
  onClick?: () => void;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const METRIC_STYLES: Record<
  NonNullable<CardMetric>['kind'],
  { bg: string; hover: string; icon: typeof Star }
> = {
  relevance: { bg: 'bg-blue-500', hover: 'hover:bg-blue-600', icon: Star },
  distance: { bg: 'bg-teal-600', hover: 'hover:bg-teal-700', icon: Navigation },
  age: { bg: 'bg-slate-500', hover: 'hover:bg-slate-600', icon: Clock },
};

/**
 * The card's ranking-basis pill: icon and value only. The basis is stated once
 * in the pinned browse toolbar, and the label would not fit beside Connect in
 * longer languages; the full sentence is in the tooltip.
 *
 * Colour follows the metric kind, not its value: BGE-M3 similarities are not
 * calibrated, so value bands would look authoritative while barely varying.
 */
export function MatchScoreBadge({
  metric,
  basis,
  onClick,
  size = 'sm',
  className,
}: Readonly<MatchScoreBadgeProps>) {
  const { t } = useTranslation();

  // Nothing determined this card's position, so there is nothing to show.
  if (!metric) return null;

  const styles = METRIC_STYLES[metric.kind];
  const Icon = styles.icon;
  const value = formatCardMetric(metric, t);
  const description = describeCardMetric(metric, basis, t);

  const sizeClasses = {
    sm: 'h-6 text-xs px-2 gap-1',
    md: 'h-7 text-sm px-2.5 gap-1.5',
    lg: 'h-8 text-base px-3 gap-2',
  };
  const iconSizes = { sm: 'h-3 w-3', md: 'h-3.5 w-3.5', lg: 'h-4 w-4' };

  const content = (
    <>
      <Icon className={cn('shrink-0', iconSizes[size])} />
      <span className="truncate">{value}</span>
    </>
  );
  const shared = cn(
    'inline-flex items-center rounded-full font-medium text-white transition-colors',
    styles.bg,
    sizeClasses[size],
    className,
  );

  // A <span> when there is nothing to open, so non-actionable pills are not
  // focusable.
  const badge = onClick ? (
    <button
      type="button"
      data-testid="card-metric-pill"
      onClick={onClick}
      aria-label={description ? `${value} — ${description}` : (value ?? undefined)}
      className={cn(
        shared,
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        styles.hover,
      )}
    >
      {content}
    </button>
  ) : (
    <span
      data-testid="card-metric-pill"
      aria-label={description ? `${value} — ${description}` : (value ?? undefined)}
      className={shared}
    >
      {content}
    </span>
  );

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <div className="space-y-1">
            {description && <p className="font-medium">{description}</p>}
            {onClick && (
              <p className="text-xs text-muted-foreground">{t('match.tooltip_view_details')}</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
