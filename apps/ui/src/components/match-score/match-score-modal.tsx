import * as React from 'react';
import { RefreshCw, TrendingUp, MapPin, BookOpen, Award, Clock, AlertCircle, CheckCircle2, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { MatchScoreResult, MatchScoreSignal } from '@/lib/match-score-api';
import { getMatchScoreBand, formatScorePercentage } from '@/utils/match-score-cache';

export interface MatchScoreModalProps {
  isOpen: boolean;
  onClose: () => void;
  score: MatchScoreResult | null;
  isLoading: boolean;
  localItemName: string;
  networkItemName: string;
  onRecalculate: () => void;
  onProceed?: () => void;
}

const signalIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  location: MapPin,
  subject: BookOpen,
  expertise: Award,
  experience: Award,
  availability: Clock,
  default: CheckCircle2,
};

function getSignalIcon(name: string) {
  const lowerName = name.toLowerCase();
  for (const [key, icon] of Object.entries(signalIcons)) {
    if (lowerName.includes(key)) return icon;
  }
  return signalIcons.default;
}

function getSignalImpactColor(impact: string): string {
  const lowerImpact = impact.toLowerCase();
  if (lowerImpact.includes('strong') || lowerImpact.includes('high')) {
    return 'text-emerald-600';
  }
  if (lowerImpact.includes('moderate') || lowerImpact.includes('medium')) {
    return 'text-amber-600';
  }
  if (lowerImpact.includes('weak') || lowerImpact.includes('low')) {
    return 'text-rose-600';
  }
  if (lowerImpact.includes('partial')) {
    return 'text-amber-600';
  }
  return 'text-slate-600';
}

function SignalItem({ signal }: { signal: MatchScoreSignal }) {
  const Icon = getSignalIcon(signal.name);
  const impactColor = getSignalImpactColor(signal.impact);

  return (
    <div className="flex items-start gap-3 py-3 border-b border-border/50 last:border-0">
      <div className="mt-0.5 shrink-0">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <h4 className="font-medium text-sm truncate">{signal.name}</h4>
          <span className={cn('text-xs font-medium shrink-0', impactColor)}>
            {signal.impact}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-1">{signal.summary}</p>
      </div>
    </div>
  );
}

export function MatchScoreModal({
  isOpen,
  onClose,
  score,
  isLoading,
  localItemName,
  networkItemName,
  onRecalculate,
  onProceed,
}: MatchScoreModalProps) {
  const { t } = useTranslation();
  const scoreValue = score?.score ?? 0;
  const styles = getMatchScoreBand(scoreValue);
  const [progressValue, setProgressValue] = React.useState(0);

  // Animate progress bar when score changes
  React.useEffect(() => {
    if (score?.score !== undefined && !isLoading) {
      const targetValue = Math.round(score.score * 100);
      const duration = 600;
      const startTime = performance.now();

      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease-out function
        const easeOut = 1 - Math.pow(1 - progress, 3);
        setProgressValue(Math.round(targetValue * easeOut));

        if (progress < 1) {
          requestAnimationFrame(animate);
        }
      };

      requestAnimationFrame(animate);
    }
  }, [score?.score, isLoading]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="flex items-center gap-2">
            <span>{t('match.modal_title')}</span>
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-180px)]">
          <div className="px-6 py-4 space-y-6">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center py-12 space-y-4">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
                <p className="text-sm text-muted-foreground animate-pulse">
                  {t('match.calculating')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('match.comparing', { localName: localItemName, networkName: networkItemName })}
                </p>
              </div>
            ) : score ? (
              <>
                {/* Score Header */}
                <div className="text-center space-y-4">
                  <div className={cn(
                    'inline-flex items-center justify-center w-20 h-20 rounded-full',
                    styles.bgColor,
                    styles.textColor
                  )}>
                    <Star className="h-10 w-10 fill-current" />
                  </div>

                  <div>
                    <div className="text-4xl font-bold tracking-tight">
                      {formatScorePercentage(scoreValue)}
                    </div>
                    <div className={cn('text-lg font-medium mt-1', styles.textColor.replace('text-white', `text-${styles.color}-600`))}>
                      {styles.label}
                    </div>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full max-w-xs mx-auto space-y-2">
                    <Progress
                      value={progressValue}
                      className="h-2"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>0%</span>
                      <span>50%</span>
                      <span>100%</span>
                    </div>
                  </div>

                  {score.confidence !== undefined && (
                    <p className="text-sm text-muted-foreground">
                      {t('match.confidence', { value: Math.round(score.confidence * 100) })}
                    </p>
                  )}
                </div>

                {/* Matching Factors */}
                {score.signals && score.signals.length > 0 && (
                  <div className="border rounded-lg p-4 space-y-3">
                    <h3 className="font-semibold flex items-center gap-2">
                      <TrendingUp className="h-4 w-4" />
                      {t('match.factors_heading')}
                    </h3>
                    <div className="divide-y divide-border">
                      {score.signals.map((signal, index) => (
                        <SignalItem key={index} signal={signal} />
                      ))}
                    </div>
                  </div>
                )}

                {/* AI Reasoning */}
                {score.reasoning && (
                  <div className="border rounded-lg p-4 space-y-3">
                    <h3 className="font-semibold flex items-center gap-2">
                      <span className="text-lg">🤔</span>
                      {t('match.ai_reasoning_heading')}
                    </h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {score.reasoning}
                    </p>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>{t('match.no_score')}</p>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="px-6 py-4 border-t flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onRecalculate}
            disabled={isLoading}
            className="gap-1.5"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
            {t('match.btn_recalculate')}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('match.btn_close')}
            </Button>
            {onProceed && (
              <Button size="sm" onClick={onProceed}>
                {t('match.btn_proceed')}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
