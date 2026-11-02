import * as React from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ReadProgress } from '@/components/consent/read-progress';

/** Document reference the tracker needs: a stable id and a fallback label. */
export interface TrackerDoc {
  id: string;
  cap: string;
}

export interface ConsentProgressTrackerProps {
  docs: TrackerDoc[];
  progress: ReadProgress;
}

/** How one document's dot renders: read, currently in hand, or not yet reached. */
type NodeState = 'read' | 'current' | 'todo';

function nodeState(docId: string, progress: ReadProgress): NodeState {
  if (progress.readIds.includes(docId)) return 'read';
  if (docId === progress.currentId) return 'current';
  return 'todo';
}

/**
 * Dot styling per node state. A keyed record rather than a chain so adding a
 * state is a type error here instead of silently taking the `todo` branch.
 */
const DOT_CLASS: Record<NodeState, string> = {
  read: 'border-primary bg-primary',
  current: 'border-primary bg-background ring-4 ring-primary/20',
  todo: 'border-border bg-background',
};

/** Per-document progress dots and fill line; null with fewer than two documents. */
export function ConsentProgressTracker({
  docs,
  progress,
}: Readonly<ConsentProgressTrackerProps>): React.JSX.Element | null {
  const { t, i18n } = useTranslation();

  // A tracker with one node reports nothing the reader cannot already see.
  if (docs.length < 2) return null;

  // The line runs between the first and last dot centres. With `n` equal
  // `flex-1` nodes, the first centre is `50 / n` percent from the left.
  const inset = 50 / docs.length;

  return (
    <div className="relative flex w-full items-start justify-between px-1.5 pt-0.5">
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
        const state = nodeState(doc.id, progress);
        // Falls back to `cap` when no `consent.cap_<id>` key exists.
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
              className={`grid h-5 w-5 place-items-center rounded-full border-2 transition-colors ${DOT_CLASS[state]}`}
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
