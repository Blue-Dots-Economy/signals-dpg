import { MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface EnableLocationBannerProps {
  onEnable: () => void;
  /**
   * True when the user has BLOCKED location for this site (a real "Never allow"
   * or a browser-imposed embargo). The browser won't re-prompt, so the CTA
   * can't do anything — we drop it and instead tell the user (via `blockedBody`)
   * to grant location permission in their browser. A plain dismiss (the ✕ on
   * the prompt) is NOT blocked — the button stays and re-prompts.
   */
  blocked?: boolean;
  /**
   * Copy (already translated) — required so this shared component carries no
   * i18n namespace of its own; each caller owns its own strings.
   */
  title: string;
  body: string;
  blockedBody: string;
  cta: string;
}

/** Presentational banner shown when geolocation is denied/unavailable; offers to enable. */
export function EnableLocationBanner({
  onEnable,
  blocked = false,
  title,
  body,
  blockedBody,
  cta,
}: EnableLocationBannerProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/50 px-4 py-2 text-sm">
      <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{title}</span>{' '}
        <span className="text-muted-foreground">{blocked ? blockedBody : body}</span>
      </div>
      {/* When blocked, the button can't re-prompt, so it's omitted — the body
          tells the user to enable location in their browser instead. */}
      {!blocked && (
        <Button size="sm" variant="outline" className="shrink-0" onClick={onEnable}>
          {cta}
        </Button>
      )}
    </div>
  );
}
