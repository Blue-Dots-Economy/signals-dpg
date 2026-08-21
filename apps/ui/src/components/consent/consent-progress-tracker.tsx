import * as React from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ReadProgress } from '@/components/consent/read-progress';

/** Document reference the tracker needs: a stable id and a fallback label. */
export interface TrackerDoc {
  id: string;
  cap: string;
}

/** Props for {@link ConsentProgressTracker}. */
export interface ConsentProgressTrackerProps {
  docs: TrackerDoc[];
  progress: ReadProgress;
}

/**
 * Renders the per-document progress dots and the connecting fill line.
 *
 * @param props - Documents in order plus current read progress.
 * @returns The tracker, or null when there are fewer than two documents.
 */
export function ConsentProgressTracker({
  docs,
  progress,
}: ConsentProgressTrackerProps): React.JSX.Element | null {
  const { t, i18n } = useTranslation();

  // A tracker with one node reports nothing the reader cannot already see.
  if (docs.length < 2) return null;

  return (
    <div className="relative mx-auto flex max-w-[340px] items-start justify-between px-1.5 pt-0.5">
      <div className="absolute left-[16.67%] right-[16.67%] top-[9px] h-0.5 overflow-hidden rounded-sm bg-border">
        <div
          data-testid="consent-progress-fill"
          className="h-full bg-primary transition-[width] duration-100 ease-linear"
          style={{ width: `${progress.fillPercent}%` }}
        />
      </div>
      {docs.map((doc) => {
        const state = progress.readIds.includes(doc.id)
          ? 'read'
          : doc.id === progress.currentId
            ? 'current'
            : 'todo';
        // The i18n key is added in a later task; until then this falls back
        // to the hardcoded `cap` so the tracker still renders a label.
        const capKey = `consent.cap_${doc.id}`;
        const label = i18n.exists(capKey) ? t(capKey) : doc.cap;
        return (
          <div
            key={doc.id}
            data-testid={`consent-node-${doc.id}`}
            data-consent-node={doc.id}
            data-state={state}
            className="relative z-10 flex flex-1 flex-col items-center gap-1.5"
          >
            <span
              className={`grid h-5 w-5 place-items-center rounded-full border-2 transition-colors ${
                state === 'read'
                  ? 'border-primary bg-primary'
                  : state === 'current'
                    ? 'border-primary bg-background ring-4 ring-primary/20'
                    : 'border-border bg-background'
              }`}
            >
              {state === 'read' && <Check className="h-3 w-3 text-primary-foreground" aria-hidden="true" />}
            </span>
            <span
              className={`text-[10.5px] font-semibold ${
                state === 'todo' ? 'text-muted-foreground' : 'text-foreground'
              }`}
            >
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
