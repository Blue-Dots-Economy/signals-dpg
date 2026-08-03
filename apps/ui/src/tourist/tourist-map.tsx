import type { ReactNode } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotCardConfig, MapMarker } from '@/engine/types';
import type { LatLng } from '@/lib/geo/types';
import { MapView } from '@/components/map/map-container';
import { PractitionerCard } from './practitioner-card';
import { resolvePractitionerIcon } from './category-icons';
import { isRubixListing, type CardItem } from './practitioner-data';
import { useThemeMode } from '@/theme/mode-provider';
import rubixLightBg from '@/assets/rubix-light-bg.svg';
import rubixDarkBg from '@/assets/rubix-dark-bg.svg';

export interface TouristMapProps {
  items: CardItem[];
  schema: RJSFSchema;
  cardConfig: DotCardConfig | null;
  /** Tourist location, or null → caller passes the region default via `center`. */
  focusPoint: LatLng | null;
  center: [number, number];
  zoom: number;
  filtersSlot?: ReactNode;
}

export function TouristMap({ items, schema, cardConfig, focusPoint, center, zoom, filtersSlot }: TouristMapProps) {
  const { resolved } = useThemeMode();
  // Theme-matched RubiX favicon used for RubiX listings' map pins.
  const rubixPin = resolved === 'dark' ? rubixDarkBg : rubixLightBg;

  return (
    <MapView
      schema={schema}
      items={items}
      center={center}
      zoom={zoom}
      focusPoint={focusPoint}
      // The tourist app has no profile — its `focusPoint` IS the browser
      // geolocation, so it doubles as the "You are here" self-marker location.
      selfLocation={focusPoint}
      filtersSlot={filtersSlot}
      // Fill the tourist app's flex container (its header is shorter than the
      // signals chrome the default height assumes), so no white space below.
      heightClassName="h-full"
      // Marker icon by practitioner category (Stay/Artists/Activities/…) rather
      // than by domain (all practitioners share one domain).
      resolveMarkerIcon={resolvePractitionerIcon}
      // RubiX listings use the RubiX favicon as their map pin.
      resolveMarkerImage={(marker) => (isRubixListing(marker.data) ? rubixPin : null)}
      renderPopup={(marker: MapMarker) => (
        <PractitionerCard data={marker.data} schema={schema} cardConfig={cardConfig} title={marker.label} variant="popup" />
      )}
    />
  );
}
