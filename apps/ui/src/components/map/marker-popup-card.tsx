import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Plug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { MapMarker, DotActionSchema } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import { useMatchScore } from '@/hooks/use-match-score';
import { MatchScoreModal } from '@/components/match-score/match-score-modal';

const HIDDEN_KEYS = new Set(['item_latitude', 'item_longitude', 'item_domain']);

interface PrecisionInfo {
  labelKey: string;
}

export function getPrecisionInfo(precision: string): PrecisionInfo {
  switch (precision) {
    case 'exact':
      return { labelKey: 'map.precision.exact' };
    case 'geocoded_pincode':
      return { labelKey: 'map.precision.pincode' };
    case 'geocoded_full_address':
      return { labelKey: 'map.precision.full_address' };
    case 'geocoded_city_only':
      return { labelKey: 'map.precision.city' };
    default:
      return { labelKey: 'map.precision.unknown' };
  }
}

function getInitials(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return '?';
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

interface MarkerPopupCardProps {
  marker: MapMarker;
  onViewDetails?: (id: string) => void;
  /** Connect action(s) available for this marker's domain (first is used). */
  actions?: DotActionSchema[];
  /** Initiate the connect flow for this marker. */
  onConnect?: () => void;
  /** Local (own) profile item — required for match score. */
  localItem?: Item | null;
  /** Full network Item for this marker — required for match score. */
  networkItem?: Item | null;
}

export function MarkerPopupCard({
  marker,
  onViewDetails,
  actions = [],
  onConnect,
  localItem,
  networkItem,
}: MarkerPopupCardProps) {
  const { t } = useTranslation();
  const initials = getInitials(marker.label);
  const precisionInfo = getPrecisionInfo(marker.precision);
  const [modalOpen, setModalOpen] = React.useState(false);

  const canMatch = !!localItem && !!networkItem;
  const canConnect = actions.length > 0 && !!onConnect;

  const { score, isLoading, calculate, recalculate } = useMatchScore({
    localItem: localItem ?? null,
    networkItem: networkItem ?? ({ item_id: marker.id, item_state: marker.data } as Item),
  });

  const fields = Object.entries(marker.data)
    .filter(([key]) => !key.startsWith('_') && !HIDDEN_KEYS.has(key))
    .slice(0, 4);

  return (
    <div className="w-[300px] overflow-hidden rounded-2xl bg-background text-foreground shadow-sm">
      {/* Branded header — colour is the per-network theme var */}
      <div
        className="flex items-center gap-3 px-4 py-3"
        style={{
          background:
            'linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary), white 32%))',
        }}
      >
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/25 text-sm font-bold text-white">
          {initials}
        </div>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-bold leading-tight text-white">{marker.label}</p>
          {marker.domain && (
            <Badge className="mt-1 border-0 bg-white/25 px-1.5 py-0 text-[10px] font-semibold text-white hover:bg-white/25">
              {titleCase(marker.domain)}
            </Badge>
          )}
          <p className="mt-1 text-[10px] leading-none text-white/85">{t(precisionInfo.labelKey)}</p>
        </div>
      </div>

      {/* Fields (schema-driven; unchanged resolution from marker.data) */}
      {fields.length > 0 && (
        <div className="space-y-1.5 px-4 py-3">
          {fields.map(([key, val]) => (
            <div key={key} className="flex items-start gap-2 text-xs">
              <span className="w-[92px] shrink-0 font-medium text-muted-foreground">{titleCase(key)}</span>
              <span className="min-w-0 flex-1 break-words text-foreground">{String(val ?? '—')}</span>
            </div>
          ))}
        </div>
      )}

      {/* Buttons */}
      {(canMatch || canConnect) ? (
        <div className="flex gap-2 px-4 pb-4 pt-1">
          {canMatch && (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={isLoading}
              onClick={() => {
                if (!score) void calculate();
                setModalOpen(true);
              }}
            >
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              {t('map.see_match_score')}
            </Button>
          )}
          {canConnect && (
            <Button size="sm" className="flex-1" onClick={onConnect}>
              <Plug className="mr-1.5 h-3.5 w-3.5" />
              {t('map.connect')}
            </Button>
          )}
        </div>
      ) : (
        onViewDetails && (
          <div className="px-4 pb-3">
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs font-medium"
              onClick={() => onViewDetails(marker.id)}
            >
              {t('map.view_details')}
            </Button>
          </div>
        )
      )}

      {canMatch && (
        <MatchScoreModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          score={score}
          isLoading={isLoading}
          localItemName={String(localItem?.item_state?.name ?? 'Your Profile')}
          networkItemName={marker.label}
          onRecalculate={() => void recalculate()}
          onProceed={
            canConnect
              ? () => {
                  setModalOpen(false);
                  onConnect?.();
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
