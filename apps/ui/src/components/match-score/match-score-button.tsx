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

export interface MatchScoreButtonProps {
  localItem: Item | null;
  networkItem: Item;
  score: MatchScoreResult | null;
  isLoading: boolean;
  error: Error | null;
  onCalculate: () => void;
  onViewDetails?: () => void;
  disabled?: boolean;
}

export function MatchScoreButton({
  localItem,
  score,
  isLoading,
  error,
  onCalculate,
  onViewDetails,
  disabled = false,
}: MatchScoreButtonProps) {
  const { t } = useTranslation();
  // If we have a score, show the badge
  if (score && !error) {
    return (
      <MatchScoreBadge
        score={score}
        onClick={onViewDetails}
        showLabel={false}
      />
    );
  }

  // If there was an error, show error state
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

  // Loading state
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

  // Default state - calculate button
  const isDisabled = disabled || !localItem;
  
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
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
