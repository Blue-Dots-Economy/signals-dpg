import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Plug, Bookmark, Share2 } from 'lucide-react';
import type { DotActionSchema } from '@/engine/types';

interface ActionButtonProps {
  actionType: string;
  actionSchema: DotActionSchema;
  onAction: (type: string, schema: DotActionSchema) => void;
  /** Disable the CTA (e.g. an action is already open for this pair). */
  disabled?: boolean;
  /** Shown on hover when disabled, so the user knows why. */
  disabledReason?: string;
  /** Button variant; the public profile page uses `'default'` for a filled CTA. */
  variant?: NonNullable<React.ComponentProps<typeof Button>['variant']>;
}

const actionIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  connect: Plug,
  bookmark: Bookmark,
  share: Share2,
};

export function ActionButton({
  actionType,
  actionSchema,
  onAction,
  disabled = false,
  disabledReason,
  variant = 'outline',
}: Readonly<ActionButtonProps>) {
  const Icon = actionIcons[actionType] ?? Plug;
  const label = actionType.charAt(0).toUpperCase() + actionType.slice(1);

  const button = (
    <Button
      data-tour="card-action"
      variant={variant}
      size="sm"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onAction(actionType, actionSchema);
      }}
      className="gap-1.5 min-w-0 max-w-full"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </Button>
  );

  // A disabled button fires no hover events, so a span carries the tooltip
  // explaining why.
  if (!disabled || !disabledReason) return button;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" tabIndex={0}>
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
