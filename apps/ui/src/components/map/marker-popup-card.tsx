import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import type { MapMarker } from '@/engine/types';

/**
 * Keys present in marker.data that are internal/plumbing and must never
 * appear as visible popup rows. These are stored on the data object for
 * geocoding and domain-routing purposes but are meaningless to end-users.
 */
const HIDDEN_KEYS = new Set([
  'item_latitude',
  'item_longitude',
  'item_domain',
]);

// ── Precision helpers ──────────────────────────────────────────────────────────

interface PrecisionInfo {
  label: string;
  colorClass: string;
}

export function getPrecisionInfo(precision: string): PrecisionInfo {
  // The label wording conveys the precision; the colour stays theme-neutral
  // (text-muted-foreground) so it reads correctly in light/dark and across
  // every network theme rather than using fixed brand colours.
  const colorClass = 'text-muted-foreground';
  switch (precision) {
    case 'exact':
      return { label: 'Exact location', colorClass };
    case 'geocoded_pincode':
      return { label: 'From pincode', colorClass };
    case 'geocoded_full_address':
      return { label: 'From full address', colorClass };
    case 'geocoded_city_only':
      return { label: 'From city (estimated)', colorClass };
    default:
      return { label: 'Unknown precision', colorClass };
  }
}

// ── Avatar initials ────────────────────────────────────────────────────────────

function getInitials(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return '?';
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

// ── Domain display ─────────────────────────────────────────────────────────────

function formatDomain(domain: string): string {
  return domain
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Key formatting ─────────────────────────────────────────────────────────────

function formatKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface MarkerPopupCardProps {
  marker: MapMarker;
  onViewDetails?: (id: string) => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function MarkerPopupCard({ marker, onViewDetails }: MarkerPopupCardProps) {
  const initials = getInitials(marker.label);
  const precisionInfo = getPrecisionInfo(marker.precision);

  const fields = Object.entries(marker.data)
    .filter(([key]) => !key.startsWith('_') && !HIDDEN_KEYS.has(key))
    .slice(0, 5);

  return (
    <div className="min-w-[248px] max-w-[280px] rounded-lg bg-background text-foreground">
      {/* Header: avatar + name + domain badge */}
      <div className="flex items-start gap-3 pb-3">
        {/* Avatar circle */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary ring-1 ring-black/5">
          {initials}
        </div>

        <div className="min-w-0 flex-1 pt-0.5">
          <p className="truncate text-sm font-semibold leading-tight text-foreground">
            {marker.label}
          </p>
          {marker.domain && (
            <div className="mt-1">
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-medium">
                {formatDomain(marker.domain)}
              </Badge>
            </div>
          )}
        </div>
      </div>

      {/* Precision hint */}
      <p className={`mb-3 text-[11px] leading-none ${precisionInfo.colorClass}`}>
        {precisionInfo.label}
        {marker.geocodedFrom && ` · ${marker.geocodedFrom}`}
      </p>

      {fields.length > 0 && (
        <>
          <Separator className="mb-3" />

          {/* Data fields */}
          <div className="space-y-1.5">
            {fields.map(([key, val]) => (
              <div key={key} className="flex items-start gap-2 text-xs">
                <span className="w-[90px] shrink-0 font-medium text-muted-foreground">
                  {formatKey(key)}
                </span>
                <span className="min-w-0 flex-1 break-words text-foreground">
                  {String(val ?? '—')}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* View details */}
      {onViewDetails && (
        <div className="mt-3 border-t pt-2.5">
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs font-medium"
            onClick={() => onViewDetails(marker.id)}
          >
            View details
          </Button>
        </div>
      )}
    </div>
  );
}
