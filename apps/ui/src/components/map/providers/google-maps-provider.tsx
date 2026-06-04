import * as React from 'react';
import {
  AdvancedMarker,
  APIProvider,
  InfoWindow,
  Map,
  Pin,
} from '@vis.gl/react-google-maps';
import type { MapMarker, MapProviderProps } from '@/engine/types';
import { registerMapProvider } from '@/engine/map/map-registry';
import { getRuntimeEnv } from '@/lib/runtime-env';

const precisionColors: Record<MapMarker['precision'], { background: string; border: string; glyph: string }> = {
  exact: { background: '#2563eb', border: '#1d4ed8', glyph: '#ffffff' },
  geocoded_pincode: { background: '#16a34a', border: '#15803d', glyph: '#ffffff' },
  geocoded_full_address: { background: '#ca8a04', border: '#a16207', glyph: '#ffffff' },
  geocoded_city_only: { background: '#ea580c', border: '#c2410c', glyph: '#ffffff' },
};

function getPrecisionLabel(marker: MapMarker): string {
  switch (marker.precision) {
    case 'exact':
      return 'Exact location';
    case 'geocoded_pincode':
      return 'From pincode';
    case 'geocoded_full_address':
      return 'From full address';
    case 'geocoded_city_only':
      return 'From city (estimated)';
  }
}

function MarkerDetails({ marker, onMarkerClick }: { marker: MapMarker; onMarkerClick?: (id: string) => void }) {
  return (
    <div className="min-w-[200px] text-sm text-foreground">
      <h3 className="font-semibold">{marker.label}</h3>
      <div className="mb-2 text-xs text-muted-foreground">
        {getPrecisionLabel(marker)}
        {marker.geocodedFrom && ` (${marker.geocodedFrom})`}
      </div>
      <div className="mt-1 text-muted-foreground">
        {Object.entries(marker.data)
          .filter(([key]) => !key.startsWith('_'))
          .slice(0, 5)
          .map(([key, val]) => (
            <div key={key}>
              <span className="font-medium">{key.replace(/_/g, ' ')}:</span>{' '}
              {String(val ?? '-')}
            </div>
          ))}
      </div>
      {onMarkerClick && (
        <button
          className="mt-2 text-primary underline"
          onClick={() => onMarkerClick(marker.id)}
          type="button"
        >
          View details
        </button>
      )}
    </div>
  );
}

export function GoogleMapProvider({
  center,
  zoom,
  markers,
  onMarkerClick,
}: MapProviderProps) {
  const [activeMarkerId, setActiveMarkerId] = React.useState<string | null>(null);
  const apiKey = getRuntimeEnv('VITE_GOOGLE_MAPS_API_KEY');

  if (!apiKey) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed">
        <div className="text-center">
          <p className="text-muted-foreground">Google Maps provider not configured.</p>
          <p className="mt-1 text-xs text-muted-foreground">Set VITE_GOOGLE_MAPS_API_KEY to render Google Maps.</p>
        </div>
      </div>
    );
  }

  return (
    <APIProvider apiKey={apiKey}>
      <Map
        defaultCenter={{ lat: center[0], lng: center[1] }}
        defaultZoom={zoom}
        gestureHandling="greedy"
        mapId="dpg-items-map"
        reuseMaps
        className="h-full w-full rounded-lg"
      >
        {markers.map((marker) => {
          const colors = precisionColors[marker.precision];
          const isActive = activeMarkerId === marker.id;

          return (
            <AdvancedMarker
              key={marker.id}
              position={{ lat: marker.lat, lng: marker.lng }}
              title={marker.label}
              onClick={() => {
                setActiveMarkerId(marker.id);
                onMarkerClick?.(marker.id);
              }}
            >
              <Pin
                background={colors.background}
                borderColor={colors.border}
                glyphColor={colors.glyph}
              />
              {isActive && (
                <InfoWindow
                  position={{ lat: marker.lat, lng: marker.lng }}
                  onCloseClick={() => setActiveMarkerId(null)}
                >
                  <MarkerDetails marker={marker} onMarkerClick={onMarkerClick} />
                </InfoWindow>
              )}
            </AdvancedMarker>
          );
        })}
      </Map>
    </APIProvider>
  );
}

registerMapProvider({ name: 'google-maps', component: GoogleMapProvider });
