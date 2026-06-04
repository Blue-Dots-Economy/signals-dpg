import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SelectableCardProps {
  id: string;
  selectMode: boolean;
  selected: boolean;
  /** When false (only meaningful in select mode), the card is dimmed + non-interactive. */
  selectable?: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}

export function SelectableCard({
  id,
  selectMode,
  selected,
  selectable = true,
  onToggle,
  children,
}: SelectableCardProps) {
  // Out of select mode: render children untouched, no wrapper behaviour.
  if (!selectMode) return <>{children}</>;

  const interactive = selectable;

  const handleActivate = () => {
    if (interactive) onToggle(id);
  };

  return (
    <div
      role="button"
      tabIndex={interactive ? 0 : -1}
      aria-pressed={selected}
      aria-disabled={!interactive}
      onClick={handleActivate}
      onKeyDown={(e) => {
        if (!interactive) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle(id);
        }
      }}
      className={cn(
        'relative rounded-[18px] transition-shadow',
        interactive ? 'cursor-pointer' : 'cursor-not-allowed opacity-45',
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
    >
      {/* Block clicks from reaching the inner card's own handlers while selecting. */}
      <div className="pointer-events-none">{children}</div>
      {/* Every selectable card shows a checkbox in select mode: an empty outline
          when unselected (signals "click to select"), filled + branded when
          selected. Non-selectable (dimmed) cards show no checkbox. */}
      {interactive && (
        <span
          className={cn(
            'absolute right-3 top-3 z-10 flex h-6 w-6 items-center justify-center rounded-full shadow-md transition-colors',
            selected
              ? 'bg-primary text-primary-foreground'
              : 'border-2 border-muted-foreground/40 bg-background/90 text-muted-foreground/40',
          )}
        >
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </span>
      )}
    </div>
  );
}
