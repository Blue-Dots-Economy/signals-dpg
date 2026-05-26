import { Sun, Moon, MonitorSmartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useThemeMode, type ThemeMode } from '@/theme/mode-provider';

// Cycle order: light → dark → system → light → …
const NEXT: Record<ThemeMode, ThemeMode> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

const META: Record<ThemeMode, { label: string; Icon: typeof Sun }> = {
  light: { label: 'Light', Icon: Sun },
  dark: { label: 'Dark', Icon: Moon },
  system: { label: 'System', Icon: MonitorSmartphone },
};

export function ThemeModeToggle() {
  const { mode, setMode } = useThemeMode();
  const { label, Icon } = META[mode];
  const nextLabel = META[NEXT[mode]].label;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Theme: ${label}. Click to switch to ${nextLabel}.`}
          onClick={() => setMode(NEXT[mode])}
        >
          <Icon className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{`Theme: ${label}`}</TooltipContent>
    </Tooltip>
  );
}
