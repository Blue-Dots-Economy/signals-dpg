import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Plug } from 'lucide-react';
import type { RJSFSchema } from '@rjsf/utils';
import { Button } from '@/components/ui/button';
import type { MapMarker, DotActionSchema, DotCardConfig } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import { useMatchScore } from '@/hooks/use-match-score';
import { MatchScoreModal } from '@/components/match-score/match-score-modal';
import { ItemCard } from '@/components/cards/item-card';
import { ShareProfileButton } from '@/components/share/share-profile-button';

interface PrecisionInfo {
  labelKey: string;
}

export function getPrecisionInfo(precision: string): PrecisionInfo {
  switch (precision) {
    case 'exact':
      return { labelKey: 'map.precision.exact' };
    case 'geocoded_full_address':
      return { labelKey: 'map.precision.full_address' };
    default:
      return { labelKey: 'map.precision.unknown' };
  }
}

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

interface MarkerPopupCardProps {
  marker: MapMarker;
  onViewDetails?: (id: string) => void;
  /** Connect action(s) available for this marker's domain (first is used). */
  actions?: DotActionSchema[];
  /** Initiate the connect flow for this marker. */
  onConnect?: () => void;
  /** Disable the connect CTA (an action is already open for this pair, #370/#422). */
  connectDisabled?: boolean;
  /** Shown on hover when the connect CTA is disabled. */
  connectDisabledReason?: string;
  /** Local (own) profile item — required for match score. */
  localItem?: Item | null;
  /** Full network Item for this marker — required for match score. */
  networkItem?: Item | null;
  /** Item schema for this marker's domain (drives field labels). */
  schema?: RJSFSchema | null;
  /** Per-domain card config from network.json. */
  cardConfig?: DotCardConfig | null;
}

export function MarkerPopupCard({
  marker,
  onViewDetails,
  actions = [],
  onConnect,
  connectDisabled = false,
  connectDisabledReason,
  localItem,
  networkItem,
  schema,
  cardConfig,
}: Readonly<MarkerPopupCardProps>) {
  const { t } = useTranslation();
  const precisionInfo = getPrecisionInfo(marker.precision);
  const [modalOpen, setModalOpen] = React.useState(false);

  const canMatch = !!localItem && !!networkItem;
  const canConnect = actions.length > 0 && !!onConnect;
  const actionLabel = actions[0]
    ? actions[0].action_type.charAt(0).toUpperCase() + actions[0].action_type.slice(1)
    : t('map.connect');

  const { score, isLoading, calculate, recalculate } = useMatchScore({
    localItem: localItem ?? null,
    networkItem: networkItem ?? ({ item_id: marker.id.includes('#') ? marker.id.split('#')[0] : marker.id, item_state: marker.data } as Item),
  });

  const actionButtons =
    canMatch || canConnect ? (
      <>
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
          // Native-title span so the "already open" reason still shows on hover
          // even though the button itself is disabled (no TooltipProvider needed
          // in the map overlay).
          <span
            className="flex-1"
            title={connectDisabled ? connectDisabledReason : undefined}
          >
            <Button
              size="sm"
              className="w-full"
              disabled={connectDisabled}
              onClick={onConnect}
            >
              <Plug className="mr-1.5 h-3.5 w-3.5" />
              {actionLabel}
            </Button>
          </span>
        )}
      </>
    ) : onViewDetails ? (
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 text-xs font-medium"
        onClick={() => onViewDetails(marker.id)}
      >
        {t('map.view_details')}
      </Button>
    ) : null;

  return (
    <>
      <ItemCard
        variant="popup"
        className="shadow-none"
        schema={schema}
        cardConfig={cardConfig}
        data={marker.data}
        title={marker.label}
        domainLabel={marker.domain ? titleCase(marker.domain) : undefined}
        precisionLabel={t(precisionInfo.labelKey)}
        actions={actionButtons}
        headerAction={
          <ShareProfileButton
            item={networkItem}
            className="flex h-7 w-7 items-center justify-center rounded-full text-white hover:bg-white/25"
          />
        }
      />

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
            canConnect && !connectDisabled
              ? () => {
                  setModalOpen(false);
                  onConnect?.();
                }
              : undefined
          }
        />
      )}
    </>
  );
}
