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

  // The line spans from the first dot's centre to the last dot's centre.
  // Each dot sits in its own `flex-1` node, so with `n` equal-width nodes,
  // node `i`'s centre (0-indexed) is at `(i + 0.5) / n`; the first dot's
  // centre is therefore `0.5 / n` = `50 / n` percent from the left, and the
  // last dot's centre is the same distance from the right. `16.67%` was
  // `50 / 3`, hardcoded for exactly three nodes — correct only there. With
  // two nodes the true centres are at 25%/75%, so that hardcoded 16.67%
  // reached past both dots. Computing it from `docs.length` keeps both node
  // counts correct instead of just the one this happened to be built for.
  const inset = 50 / docs.length;

  return (
    <div className="relative mx-auto flex max-w-[340px] items-start justify-between px-1.5 pt-0.5">
      <div
        data-testid="consent-progress-track"
        className="absolute top-[9px] h-0.5 overflow-hidden rounded-sm bg-border"
        style={{ left: `${inset}%`, right: `${inset}%` }}
      >
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
