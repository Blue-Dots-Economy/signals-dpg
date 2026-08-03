import { Star, TrendingUp, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MatchScoreResult } from '@/lib/match-score-api';
import { formatScorePercentage } from '@/utils/match-score-cache';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export interface MatchScoreBadgeProps {
  score: MatchScoreResult;
  onClick?: () => void;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

function getScoreStyles(score: number) {
  // Backend returns scores on a 0-10 scale (mirrors `getMatchScoreBand` in
  // `@/utils/match-score-cache`); normalize before comparing to the 0-1
  // thresholds below. Without this, any real score >= 0.85 (i.e. almost any
  // score above ~1 on the 0-10 scale) was misclassified "Excellent".
  const normalizedScore = score / 10;
  if (normalizedScore >= 0.85) {
    return {
      label: 'Excellent',
      bgColor: 'bg-emerald-500',
      hoverColor: 'hover:bg-emerald-600',
      textColor: 'text-white',
      borderColor: 'border-emerald-500',
      icon: Star,
    };
  }
  if (normalizedScore >= 0.70) {
    return {
      label: 'Good',
      bgColor: 'bg-blue-500',
      hoverColor: 'hover:bg-blue-600',
      textColor: 'text-white',
      borderColor: 'border-blue-500',
      icon: TrendingUp,
    };
  }
  if (normalizedScore >= 0.50) {
    return {
      label: 'Moderate',
      bgColor: 'bg-amber-500',
      hoverColor: 'hover:bg-amber-600',
      textColor: 'text-white',
      borderColor: 'border-amber-500',
      icon: TrendingUp,
    };
  }
  return {
    label: 'Low',
    bgColor: 'bg-rose-500',
    hoverColor: 'hover:bg-rose-600',
    textColor: 'text-white',
    borderColor: 'border-rose-500',
    icon: AlertCircle,
  };
}

export function MatchScoreBadge({
  score,
  onClick,
  showLabel = true,
  size = 'sm',
  className,
}: MatchScoreBadgeProps) {
  const scoreValue = score.score ?? 0;
  const styles = getScoreStyles(scoreValue);
  const Icon = styles.icon;

  const sizeClasses = {
    sm: 'h-6 text-xs px-2 gap-1',
    md: 'h-7 text-sm px-2.5 gap-1.5',
    lg: 'h-8 text-base px-3 gap-2',
  };

  const iconSizes = {
    sm: 'h-3 w-3',
    md: 'h-3.5 w-3.5',
    lg: 'h-4 w-4',
  };

  const badge = (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center rounded-full font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        styles.bgColor,
        styles.textColor,
        onClick && styles.hoverColor,
        sizeClasses[size],
        className
      )}
    >
      <Icon className={cn('shrink-0', iconSizes[size])} />
      <span className="truncate">
        {formatScorePercentage(scoreValue)}
        {showLabel && ` ${styles.label}`}
      </span>
    </button>
  );

  // Add tooltip with confidence and reasoning preview
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <div className="space-y-1">
            <p className="font-medium">{styles.label} Match</p>
            {/* Absent on a discover-seeded score (`source: 'discover'`,
                #394) — only `/v1/relevance` results set `confidence`.
                `!== undefined` (not truthy) so a real confidence of 0 still
                renders instead of being hidden. */}
            {score.confidence !== undefined && (
              <p className="text-xs text-muted-foreground">
                Confidence: {Math.round(score.confidence * 100)}%
              </p>
            )}
            {score.reasoning && (
              <p className="text-xs text-muted-foreground line-clamp-2">
                {score.reasoning}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Click to view details
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
