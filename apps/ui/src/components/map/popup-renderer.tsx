import * as React from 'react';
import type { MapMarker } from '@/engine/types';
import { MarkerPopupCard } from './marker-popup-card';

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
