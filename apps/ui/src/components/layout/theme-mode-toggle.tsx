import { Sun, Moon, MonitorSmartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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

// Labels are i18n keys; the component resolves them via t() at render so the
// tooltip + aria-label read in the active locale.
const META: Record<ThemeMode, { labelKey: string; Icon: typeof Sun }> = {
  light: { labelKey: 'theme.label_light', Icon: Sun },
  dark: { labelKey: 'theme.label_dark', Icon: Moon },
  system: { labelKey: 'theme.label_system', Icon: MonitorSmartphone },
};

export function ThemeModeToggle() {
  const { mode, setMode } = useThemeMode();
  const { t } = useTranslation();
  const { labelKey, Icon } = META[mode];
  const label = t(labelKey);
  const nextLabel = t(META[NEXT[mode]].labelKey);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('theme.aria_label', { label, nextLabel })}
          onClick={() => setMode(NEXT[mode])}
        >
          <Icon className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t('theme.tooltip', { label })}</TooltipContent>
    </Tooltip>
  );
}
