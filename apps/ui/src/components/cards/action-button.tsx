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
  /** Disable the CTA (e.g. an action is already open for this pair, #370/#422). */
  disabled?: boolean;
  /** Shown on hover when disabled, so the user knows why. */
  disabledReason?: string;
  /**
   * Button visual variant. Defaults to `'outline'` so every existing card call
   * site is unchanged; the public profile page passes `'default'` for a filled,
   * theme-coloured Apply/Connect CTA.
   */
  variant?: React.ComponentProps<typeof Button>['variant'];
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
}: ActionButtonProps) {
  const Icon = actionIcons[actionType] ?? Plug;
  const label = actionType.charAt(0).toUpperCase() + actionType.slice(1);

  const button = (
    <Button
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

  // A native `disabled` button suppresses hover/title events, so wrap it in a
  // span the tooltip can hook onto — that's how the user learns why it's off
  // (an action is already open for this pair). No reason → plain button.
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
