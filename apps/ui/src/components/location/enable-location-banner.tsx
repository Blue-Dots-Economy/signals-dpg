import { MapPin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export interface EnableLocationBannerProps {
  onEnable: () => void;
  /**
   * True when the user has BLOCKED location for this site (a real "Never allow"
   * or a browser-imposed embargo). The browser won't re-prompt, so the
   * "Enable location" button can't do anything — we drop it and instead tell
   * the user to grant location permission in their browser. A plain dismiss
   * (the ✕ on the prompt) is NOT blocked — the button stays and re-prompts.
   */
  blocked?: boolean;
  /** Copy overrides (already translated). Default to the tourist strings. */
  title?: string;
  body?: string;
  blockedBody?: string;
  cta?: string;
}

/** Shown when geolocation is denied/unavailable: all results are shown; offer to enable. */
export function EnableLocationBanner({
  onEnable,
  blocked = false,
  title,
  body,
  blockedBody,
  cta,
}: EnableLocationBannerProps) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t('tourist.enable_location_title');
  const resolvedBody = blocked
    ? (blockedBody ?? t('tourist.enable_location_blocked_body'))
    : (body ?? t('tourist.enable_location_body'));
  const resolvedCta = cta ?? t('tourist.enable_location_cta');
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/50 px-4 py-2 text-sm">
      <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{resolvedTitle}</span>{' '}
        <span className="text-muted-foreground">{resolvedBody}</span>
      </div>
      {/* When blocked, the button can't re-prompt, so it's omitted — the body
          tells the user to enable location in their browser instead. */}
      {!blocked && (
        <Button size="sm" variant="outline" className="shrink-0" onClick={onEnable}>
          {resolvedCta}
        </Button>
      )}
    </div>
  );
}
