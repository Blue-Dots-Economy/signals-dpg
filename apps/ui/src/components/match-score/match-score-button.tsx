import { Sparkles, Loader2, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { Item } from '@/lib/item-api';
import type { MatchScoreResult } from '@/lib/match-score-api';
import { MatchScoreBadge } from './match-score-badge';
import type { CardMetric } from '@/lib/metric-display';

export interface MatchScoreButtonProps {
  localItem: Item | null;
  networkItem: Item;
  score: MatchScoreResult | null;
  /**
   * The card's ranking basis from the sort the server applied; null when
   * nothing determined the position (the calculate CTA shows instead). Omit
   * outside a sorted list, where the profile relevance score is the default.
   */
  metric?: CardMetric;
  /** Which quantity `relevance` means; only used for the tooltip. */
  basis?: 'profile' | 'search' | null;
  isLoading: boolean;
  error: Error | null;
  onCalculate: () => void;
  onViewDetails?: () => void;
  disabled?: boolean;
}

export function MatchScoreButton({
  localItem,
  score,
  metric,
  basis,
  isLoading,
  error,
  onCalculate,
  onViewDetails,
  disabled = false,
}: MatchScoreButtonProps) {
  const { t } = useTranslation();
  // `undefined`: no sort context, so use the profile relevance score. `null`:
  // the sort produced no metric, which is respected.
  let effectiveMetric: CardMetric = metric ?? null;
  if (metric === undefined && score?.score != null) {
    effectiveMetric = { kind: 'relevance', percent: score.score };
  }

  if (effectiveMetric && !error) {
    // Only a relevance pill opens the score modal, which explains a cosine
    // score. Without a handler the badge renders as plain text.
    const opensDetails = effectiveMetric.kind === 'relevance';
    return (
      <MatchScoreBadge
        metric={effectiveMetric}
        basis={basis ?? 'profile'}
        onClick={opensDetails ? onViewDetails : undefined}
      />
    );
  }

  if (error) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onCalculate}
              className="gap-1.5 text-muted-foreground hover:text-destructive"
            >
              <AlertCircle className="h-3.5 w-3.5" />
              <span className="text-xs">{t('match.btn_unable')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="max-w-xs text-xs">
              {t('match.tooltip_retry')}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (isLoading) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        className="gap-1.5 min-w-0"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="truncate">{t('match.calculating_short')}</span>
      </Button>
    );
  }

  const isDisabled = disabled || !localItem;
  
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            data-tour="card-match-score"
            onClick={onCalculate}
            disabled={isDisabled}
            className="gap-1.5 min-w-0 max-w-full"
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t('match.btn_see_score')}</span>
          </Button>
        </TooltipTrigger>
        {isDisabled && (
          <TooltipContent side="top">
            <p className="max-w-xs text-xs">
                {!localItem
                ? t('match.tooltip_need_profile')
                : t('match.tooltip_need_signin')
              }
            </p>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
}
