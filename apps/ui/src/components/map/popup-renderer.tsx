import * as React from 'react';
import type { MapMarker, MapProviderProps, OpenSpotGroup } from '@/engine/types';
import { MarkerPopupCard } from './marker-popup-card';
import { SpotGroupCard } from './spot-group-card';

type RenderPopup = ((marker: MapMarker) => React.ReactNode) | undefined;

const PopupRendererContext = React.createContext<RenderPopup>(undefined);

export const PopupRendererProvider = PopupRendererContext.Provider;

/** An open popup's content, rendered with the caller's latest `renderPopup` even when the memoised pin around it does not re-render. */
export function PopupBody({
  marker,
  onViewDetails,
}: {
  marker: MapMarker;
  onViewDetails?: (id: string) => void;
}) {
  const renderPopup = React.useContext(PopupRendererContext);
  return renderPopup ? <>{renderPopup(marker)}</> : <MarkerPopupCard marker={marker} onViewDetails={onViewDetails} />;
}

const SpotGroupRendererContext = React.createContext<MapProviderProps['renderSpotGroup']>(undefined);

export const SpotGroupRendererProvider = SpotGroupRendererContext.Provider;

/** An open same-spot card, rendered with the caller's latest `renderSpotGroup` even when the memoised bubble around it does not re-render. */
export function SpotGroupBody({ group, onClose }: { group: OpenSpotGroup; onClose: () => void }) {
  const renderSpotGroup = React.useContext(SpotGroupRendererContext);
  return renderSpotGroup ? <>{renderSpotGroup(group, onClose)}</> : <SpotGroupCard group={group} onClose={onClose} />;
}
