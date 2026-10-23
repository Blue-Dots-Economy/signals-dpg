import { MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface EnableLocationBannerProps {
  onEnable: () => void;
  /**
   * Location is blocked for this site ("Never allow" or a browser embargo), so
   * the browser will not re-prompt: the CTA is dropped and `blockedBody`
   * explains. A dismissed prompt is not blocked; the button re-prompts.
   */
  blocked?: boolean;
  /** Translated copy; each caller owns its strings. */
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
      {/* Omitted when blocked, since it cannot re-prompt. */}
      {!blocked && (
        <Button size="sm" variant="outline" className="shrink-0" onClick={onEnable}>
          {cta}
        </Button>
      )}
    </div>
  );
}
